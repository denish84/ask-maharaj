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
const PDF_PATH = process.argv[2];
const DOC_NAME = path.basename(PDF_PATH);

async function getEmbedding(text, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text }] }
        })
      }
    );
    const data = await res.json();
    if (res.status === 429) {
      const wait = Math.pow(2, attempt) * 2000;
      console.warn(`Rate limited. Waiting ${wait}ms before retry ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!data.embedding || !data.embedding.values) {
      console.error('Gemini API error response:', JSON.stringify(data));
      return null;
    }
    return data.embedding.values;
  }
  console.error('Max retries reached for chunk, skipping.');
  return null;
}

function chunkText(pages) {
  const chunks = [];
  for (const { text, pageNum } of pages) {
    let start = 0;
    while (start < text.length) {
      const end = start + CHUNK_SIZE;
      chunks.push({
        content: text.slice(start, end),
        page_start: pageNum,
        page_end: pageNum
      });
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }
  return chunks;
}

async function main() {
  if (!PDF_PATH) { console.error('Usage: node scripts/ingest-pdf.js <path-to-pdf>'); process.exit(1); }

  console.log('Reading PDF...');
  const buffer = fs.readFileSync(PDF_PATH);
  const parsed = await pdf(buffer, {
    pagerender: (pageData) => pageData.getTextContent().then(tc => tc.items.map(i => i.str).join(' '))
  });

  const pages = parsed.text.split('\f').map((text, i) => ({ text: text.trim(), pageNum: i + 1 })).filter(p => p.text.length > 50);

  console.log(`Pages extracted: ${pages.length}`);
  const chunks = chunkText(pages);
  console.log(`Chunks created: ${chunks.length}`);

  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({ name: DOC_NAME })
    .select()
    .single();
  if (docErr) throw docErr;

  console.log('Embedding and uploading chunks...');
  const BATCH_SIZE = 50;
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchStart = batchIdx * BATCH_SIZE;
    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);

    // Filter out already-ingested chunks (dedupe by content).
    const toEmbed = [];
    for (let j = 0; j < batch.length; j++) {
      const i = batchStart + j;
      const chunk = batch[j];
      const { data: existing } = await supabase
        .from('chunks')
        .select('id')
        .eq('content', chunk.content)
        .maybeSingle();

      if (existing) {
        console.log(`Chunk ${i} already exists, skipping.`);
        continue;
      }
      toEmbed.push(chunk);
    }

    if (toEmbed.length === 0) {
      console.log(`Batch ${batchIdx + 1}/${totalBatches} complete (0 chunks inserted)`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    // Retry the entire batch if Gemini responds with 429.
    const retries = 5;
    let batchData = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const batchRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: toEmbed.map(chunk => ({
              model: 'models/gemini-embedding-001',
              content: { parts: [{ text: chunk.content }] }
            }))
          })
        }
      );

      batchData = await batchRes.json();
      if (batchRes.status === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        console.warn(`Rate limited. Waiting ${wait}ms before retry ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      break;
    }

    const embeddings = batchData?.embeddings;
    if (!embeddings || !Array.isArray(embeddings)) {
      console.error('Gemini batch embedding error response:', JSON.stringify(batchData));
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const rows = toEmbed
      .map((chunk, idx) => {
        const embedding = embeddings[idx]?.values;
        if (!embedding) return null;
        return {
          document_id: doc.id,
          content: chunk.content,
          page_start: chunk.page_start,
          page_end: chunk.page_end,
          embedding
        };
      })
      .filter(Boolean);

    let insertedCount = 0;
    if (rows.length > 0) {
      const { error } = await supabase.from('chunks').insert(rows);
      if (error) {
        console.error(`Batch ${batchIdx + 1} insert error:`, error.message);
      } else {
        insertedCount = rows.length;
      }
    }

    console.log(`Batch ${batchIdx + 1}/${totalBatches} complete (${insertedCount} chunks inserted)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('Ingest complete.');
}

main().catch(console.error);
