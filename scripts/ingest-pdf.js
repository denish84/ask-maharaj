import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 50;
const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES = 1000;
const MAX_BATCHES = Infinity;
const PDF_PATH = process.argv[2];
const DOC_NAME = path.basename(PDF_PATH);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function batchEmbed(chunks, retries = 6) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: chunks.map(chunk => ({
            model: 'models/gemini-embedding-001',
            outputDimensionality: 3072,
            taskType: 'RETRIEVAL_DOCUMENT',
            content: { parts: [{ text: chunk.content }] }
          }))
        })
      }
    );

    if (res.status === 429) {
      const wait = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s, 40s...
      console.warn(`  [429] Rate limited. Waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}...`);
      await sleep(wait);
      continue;
    }

    const data = await res.json();

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      console.error('  Gemini error response:', JSON.stringify(data));
      if (attempt < retries - 1) {
        await sleep(5000);
        continue;
      }
      return null;
    }

    return data.embeddings;
  }

  console.error('  Max retries reached, skipping batch.');
  return null;
}

function chunkText(pages) {
  const chunks = [];
  for (const { text, pageNum } of pages) {
    const firstLine = text.split(/\r?\n/)[0] || text;
    const section = detectSection(firstLine);
    let start = 0;
    while (start < text.length) {
      let end = start + CHUNK_SIZE;
      if (end < text.length) {
        let lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start + CHUNK_SIZE - 150) {
          end = lastSpace;
        }
      }
      chunks.push({
        content: text.slice(start, end).trim(),
        page_start: pageNum,
        page_end: pageNum,
        section: section || 'Unknown'
      });
      if (end >= text.length) break;
      start = end - CHUNK_OVERLAP;
      if (start > 0) {
        let nextSpace = text.indexOf(' ', start);
        if (nextSpace !== -1 && nextSpace < start + 100) {
          start = nextSpace + 1;
        }
      }
    }
  }
  return chunks;
}

function detectSection(text) {
  const match = text.match(/^(GADHADÃ\s*[I]+|SÃRANGPUR|KÃRIYÃNI|LOYÃ|PANCHÃLÃ|VADTÃL|AMDÃVÃD|JETALPUR)/i);
  return match ? match[1].trim() : null;
}

async function getOrCreateDocument(name) {
  const { data: existing } = await supabase
    .from('documents')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    console.log(`Document "${name}" already exists (id: ${existing.id}), reusing.`);
    return existing;
  }

  const { data: doc, error } = await supabase
    .from('documents')
    .insert({ name })
    .select()
    .single();

  if (error) throw error;
  console.log(`Created new document "${name}" (id: ${doc.id})`);
  return doc;
}

async function main() {
  if (!PDF_PATH) {
    console.error('Usage: node scripts/ingest-pdf.js <path-to-pdf>');
    process.exit(1);
  }

  console.log('Reading PDF...');
  const buffer = fs.readFileSync(PDF_PATH);
  const parsed = await pdf(buffer, {
    pagerender: (pageData) => pageData.getTextContent().then(tc => {
      return tc.items.map(i => i.str).join(' ') + '\n\f';
    })
  });

  const pages = parsed.text
    .split('\f')
    .map((text, i) => ({ text: text.trim(), pageNum: i + 1 }))
    .filter(p => p.text.length > 0);

  console.log(`Pages extracted: ${pages.length}`);
  const allChunks = chunkText(pages);
  console.log(`Chunks created: ${allChunks.length}`);

  const doc = await getOrCreateDocument(DOC_NAME);
  const chunks = allChunks;
  console.log(`Total chunks to process: ${chunks.length}`);

  if (chunks.length === 0) {
    console.log('All chunks already ingested. Nothing to do.');
    return;
  }

  console.log(`Embedding ${chunks.length} new chunks in batches of ${BATCH_SIZE} (max ${MAX_BATCHES} batches)...`);
  const totalBatches = Math.min(Math.ceil(chunks.length / BATCH_SIZE), MAX_BATCHES);
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalProcessed = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const batch = chunks.slice(start, start + BATCH_SIZE);
    totalProcessed += batch.length;

    process.stdout.write(`Batch ${batchIdx + 1}/${totalBatches}... `);

    const embeddings = await batchEmbed(batch);
    if (!embeddings) {
      totalFailed += batch.length;
      console.log('SKIPPED (embedding failed)');
      continue;
    }

    const rows = batch
      .map((chunk, idx) => {
        const embedding = embeddings[idx]?.values;
        if (!embedding) return null;
        return {
          document_id: doc.id,
          content: chunk.content,
          page_start: chunk.page_start,
          page_end: chunk.page_end,
          section: chunk.section,
          embedding
        };
      })
      .filter(Boolean);

    totalSkipped += batch.length - rows.length;

    if (rows.length > 0) {
      const { error } = await supabase.from('chunks').insert(rows);
      if (error) {
        totalFailed += rows.length;
        console.log(`INSERT ERROR: ${error.message}`);
      } else {
        totalInserted += rows.length;
        console.log(`OK (${rows.length} inserted)`);
      }
    }

    // Steady throttle between batches to stay under rate limit
    if (batchIdx < totalBatches - 1) {
      await sleep(DELAY_BETWEEN_BATCHES);
    }
  }

  console.log(`
─────────────────────────────
  Ingest complete
  Total processed : ${totalProcessed}
  Inserted        : ${totalInserted}
  Skipped         : ${totalSkipped}
  Failed          : ${totalFailed}
  Batches run     : ${totalBatches} / ${Math.ceil(chunks.length / BATCH_SIZE)} total
─────────────────────────────`);
}

main().catch(console.error);