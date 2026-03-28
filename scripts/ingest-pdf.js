import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES = 1000;
const PDF_PATH = process.argv[2];

// Recursive splitter — respects paragraph → line → word boundaries
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 200,
  separators: ['\n\n', '\n', ' ', '']
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function detectSection(text) {
  const match = text.match(
    /(GADHADÃ?\s*I{1,3}|GADHADA\s*I{1,3}|SÃRANGPUR|SARANGPUR|KÃRIYÃNI|KARIYANI|LOYÃ|LOYA|PANCHÃLÃ|PANCHALA|VADTÃL|VADTAL|AMDÃVÃD|AHMEDABAD|JETALPUR)/i
  );
  return match ? normalizeSection(match[1].trim().toUpperCase()) : null;
}

function normalizeSection(section) {
  if (!section) return null;
  const map = {
    'GADHADA I': 'GADHADA I',
    'GADHADÃ I': 'GADHADA I',
    'GADHADA II': 'GADHADA II',
    'GADHADÃ II': 'GADHADA II',
    'GADHADA III': 'GADHADA III',
    'GADHADÃ III': 'GADHADA III',
    SARANGPUR: 'SARANGPUR',
    'SÃRANGPUR': 'SARANGPUR',
    KARIYANI: 'KARIYANI',
    'KÃRIYÃNI': 'KARIYANI',
    LOYA: 'LOYA',
    'LOYÃ': 'LOYA',
    PANCHALA: 'PANCHALA',
    'PANCHÃLÃ': 'PANCHALA',
    VADTAL: 'VADTAL',
    'VADTÃL': 'VADTAL',
    AHMEDABAD: 'AMDAVAD',
    'AMDÃVÃD': 'AMDAVAD',
    JETALPUR: 'JETALPUR'
  };
  return map[section] || section;
}

// Carry section forward — once detected on a page it applies to all
// subsequent pages until a new section header is found
async function buildChunks(pages) {
  const chunks = [];
  let currentSection = 'Unknown';

  for (const { text, pageNum } of pages) {
    // Update section if this page has a header
    const detected = detectSection(text);
    if (detected) currentSection = detected;

    // Split this page's text into recursive chunks
    const docs = await splitter.createDocuments([text]);

    for (const doc of docs) {
      const content = doc.pageContent.trim();
      if (content.length < 50) continue; // skip tiny fragments
      chunks.push({
        content,
        page_start: pageNum,
        page_end: pageNum,
        section: currentSection
      });
    }
  }

  return chunks;
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
      const wait = Math.pow(2, attempt) * 5000;
      console.warn(`  [429] Rate limited. Waiting ${wait / 1000}s (attempt ${attempt + 1}/${retries})...`);
      await sleep(wait);
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      console.error(`  [${res.status}] Gemini returned non-JSON response`);
      if (attempt < retries - 1) { await sleep(5000); continue; }
      return null;
    }

    if (!res.ok || !data.embeddings || !Array.isArray(data.embeddings)) {
      console.error(`  [${res.status}] Gemini error:`, JSON.stringify(data));
      if (attempt < retries - 1) { await sleep(5000); continue; }
      return null;
    }

    return data.embeddings;
  }

  console.error('  Max retries reached, skipping batch.');
  return null;
}

async function getOrCreateDocument(name) {
  const { data: existing, error: selectError } = await supabase
    .from('documents')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (selectError) {
    console.error('Document lookup failed:', selectError.message);
    throw selectError;
  }

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
  console.log(`Created document "${name}" (id: ${doc.id})`);
  return doc;
}

async function filterNewChunks(chunks, documentId) {
  const DEDUPE_BATCH = 100;
  const existingSet = new Set();

  for (let i = 0; i < chunks.length; i += DEDUPE_BATCH) {
    const batch = chunks.slice(i, i + DEDUPE_BATCH);
    const contents = batch.map(c => c.content);
    const { data: existing, error } = await supabase
      .from('chunks')
      .select('content, section')
      .eq('document_id', documentId)
      .in('content', contents);

    if (error) {
      console.error('Dedupe query failed:', error.message);
      throw error;
    }

    (existing || []).forEach(r => existingSet.add(`${r.content}::${r.section}`));
  }

  const newChunks = chunks.filter(c => !existingSet.has(`${c.content}::${c.section}`));
  if (chunks.length !== newChunks.length) {
    console.log(`Skipping ${chunks.length - newChunks.length} already-ingested chunks.`);
  }
  return newChunks;
}

async function main() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing required env variable: ${key}`);
      process.exit(1);
    }
  }

  if (!PDF_PATH) {
    console.error('Usage: node scripts/ingest-pdf.js <path-to-pdf>');
    process.exit(1);
  }

  const DOC_NAME = path.basename(PDF_PATH);

  console.log('Reading PDF...');
  let buffer;
  try {
    buffer = fs.readFileSync(PDF_PATH);
  } catch (err) {
    console.error(`Could not read file: ${PDF_PATH}`);
    console.error(err?.message || err);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = await pdf(buffer, {
      pagerender: (pageData) => pageData.getTextContent().then(tc => {
        let lastY = null;
        return tc.items.map(item => {
          const y = item.transform?.[5] ?? null;
          const prefix = lastY !== null && y !== null && Math.abs(y - lastY) > 5 ? '\n' : ' ';
          lastY = y;
          return prefix + item.str;
        }).join('').trim();
      })
    });
  } catch (err) {
    console.error('Failed to parse PDF:', err?.message || err);
    process.exit(1);
  }

  const pages = parsed.text
    .split('\f')
    .map((text, i) => ({ text: text.trim(), pageNum: i + 1 }))
    .filter(p => p.text.length > 0);

  console.log(`Pages extracted: ${pages.length}`);
  console.log('Building recursive chunks...');

  const allChunks = await buildChunks(pages);
  console.log(`Recursive chunks created: ${allChunks.length}`);

  // Show section breakdown
  const sectionCounts = {};
  for (const c of allChunks) {
    sectionCounts[c.section] = (sectionCounts[c.section] || 0) + 1;
  }
  console.log('Section breakdown:');
  for (const [section, count] of Object.entries(sectionCounts)) {
    console.log(`  ${section}: ${count} chunks`);
  }

  const doc = await getOrCreateDocument(DOC_NAME);
  const chunks = await filterNewChunks(allChunks, doc.id);

  if (chunks.length === 0) {
    console.log('All chunks already ingested. Nothing to do.');
    return;
  }

  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
  console.log(`\nEmbedding ${chunks.length} chunks in ${totalBatches} batches of ${BATCH_SIZE}...`);

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
  Batches run     : ${totalBatches}
─────────────────────────────`);
}

main().catch(console.error);