import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
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
const DRY_RUN = process.argv.includes('--dry-run');

// Recursive splitter — respects paragraph → line → word boundaries
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 200,
  separators: ['\n\n', '\n', ' ', '']
});

// Page marker injected between pages so we can recover page numbers after splitting
const PAGE_MARKER = (n) => `\n\n<<<PAGE:${n}>>>\n\n`;
const PAGE_MARKER_RE = /<<<PAGE:(\d+)>>>/g;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function hashContent(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
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
    'GADHADA I':   'GADHADA I',
    'GADHADÃ I':   'GADHADA I',
    'GADHADA II':  'GADHADA II',
    'GADHADÃ II':  'GADHADA II',
    'GADHADA III': 'GADHADA III',
    'GADHADÃ III': 'GADHADA III',
    'SARANGPUR':   'SARANGPUR',
    'SÃRANGPUR':   'SARANGPUR',
    'KARIYANI':    'KARIYANI',
    'KÃRIYÃNI':    'KARIYANI',
    'LOYA':        'LOYA',
    'LOYÃ':        'LOYA',
    'PANCHALA':    'PANCHALA',
    'PANCHÃLÃ':    'PANCHALA',
    'VADTAL':      'VADTAL',
    'VADTÃL':      'VADTAL',
    'AHMEDABAD':   'AMDAVAD',
    'AMDÃVÃD':     'AMDAVAD',
    'JETALPUR':    'JETALPUR'
  };
  return map[section] || section;
}

// Build a page-number lookup table from a text block containing PAGE_MARKERs.
// Returns [{offset, pageNum}] sorted by offset.
function buildPageIndex(text) {
  const index = [{ offset: 0, pageNum: 1 }];
  PAGE_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = PAGE_MARKER_RE.exec(text)) !== null) {
    index.push({ offset: match.index, pageNum: Number(match[1]) });
  }
  return index;
}

// Return the page number that applies at a given character offset.
function pageAtOffset(index, offset) {
  let pageNum = index[0].pageNum;
  for (const entry of index) {
    if (entry.offset > offset) break;
    pageNum = entry.pageNum;
  }
  return pageNum;
}

// Build a discourse-number lookup from text.
// Returns [{index, label}] in document order.
function buildDiscourseIndex(text) {
  const re = /\b(GADHAD[AÃ]\s*I{1,3}|S[AÃ]RANGPUR|K[AÃ]RIY[AÃ]NI|LOY[AÃ]|PANCH[AÃ]L[AÃ]|VADT[AÃ]L|AMD[AÃ]V[AÃ]D|JETALPUR)\s*[-–]?\s*(\d+)/gi;
  const entries = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.push({ index: m.index, label: `${m[1].trim()} ${m[2]}` });
  }
  return entries;
}

// Return the last discourse label whose position is <= offset.
function discourseAtOffset(discourseIndex, offset) {
  let label = null;
  for (const entry of discourseIndex) {
    if (entry.index > offset) break;
    label = entry.label;
  }
  return label;
}

async function buildChunks(pages) {
  const chunks = [];

  // ── Group consecutive pages by section ──────────────────────────────────────
  const groups = [];
  let currentSection = 'Unknown';
  let currentGroup = { section: 'Unknown', pages: [] };

  for (const page of pages) {
    const detected = detectSection(page.text);
    if (detected && detected !== currentSection) {
      if (currentGroup.pages.length > 0) groups.push(currentGroup);
      currentSection = detected;
      currentGroup = { section: detected, pages: [] };
    }
    currentGroup.pages.push(page);
  }
  if (currentGroup.pages.length > 0) groups.push(currentGroup);

  // ── Process each section as one concatenated block ───────────────────────────
  for (const group of groups) {
    // Join pages with markers — markers let us recover page numbers after splitting
    const fullText = group.pages
      .map(p => PAGE_MARKER(p.pageNum) + p.text)
      .join('\n\n');

    const pageIndex      = buildPageIndex(fullText);
    const discourseIndex = buildDiscourseIndex(fullText);

    const docs = await splitter.createDocuments([fullText]);

    let searchFrom = 0;

    for (const doc of docs) {
      const rawContent = doc.pageContent.trim();

      // Strip any PAGE_MARKERs that landed inside a chunk due to overlap
      const cleanContent = rawContent.replace(/<<<PAGE:\d+>>>/g, '').trim();
      if (cleanContent.length < 50) continue;

      // Try progressively shorter anchors if the first attempt fails
      let chunkOffset = -1;
      for (const anchorLen of [120, 80, 50]) {
        const anchor = rawContent.slice(0, anchorLen);
        chunkOffset = fullText.indexOf(anchor, searchFrom);
        if (chunkOffset === -1) chunkOffset = fullText.indexOf(anchor); // overlap fallback
        if (chunkOffset !== -1) break;
      }
      if (chunkOffset !== -1) searchFrom = chunkOffset + 1;

      const effectiveOffset = chunkOffset === -1 ? 0 : chunkOffset;

      chunks.push({
        content:            cleanContent,
        content_hash:       hashContent(cleanContent),
        page_start:         pageAtOffset(pageIndex, effectiveOffset),
        page_end:           pageAtOffset(pageIndex, effectiveOffset),
        section:            group.section,
        vachanamrut_number: discourseAtOffset(discourseIndex, effectiveOffset)
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
  let dedupeSkipLogged = false;

  for (let i = 0; i < chunks.length; i += DEDUPE_BATCH) {
    const batch = chunks.slice(i, i + DEDUPE_BATCH);
    const hashes = batch.map(c => c.content_hash);

    const { data: existing, error } = await supabase
      .from('chunks')
      .select('content_hash')
      .eq('document_id', documentId)
      .in('content_hash', hashes);

    if (error) {
      if (!dedupeSkipLogged) {
        console.log('No existing chunks found, skipping dedupe.');
        dedupeSkipLogged = true;
      }
      continue;
    }

    (existing || []).forEach(r => existingSet.add(r.content_hash));
  }

  const newChunks = chunks.filter(c => !existingSet.has(c.content_hash));
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

  let pages = [];
  try {
    const uint8Array = new Uint8Array(buffer);
    const pdfDoc = await getDocument({ data: uint8Array }).promise;
    const numPages = pdfDoc.numPages;
    console.log(`PDF loaded: ${numPages} pages`);

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ').trim();
      if (text.length > 0) {
        pages.push({ text, pageNum });
      }
    }
  } catch (err) {
    console.error('Failed to parse PDF:', err?.message || err);
    process.exit(1);
  }

  console.log(`Pages extracted: ${pages.length}`);
  console.log('Building recursive chunks...');

  const allChunks = await buildChunks(pages);
  console.log(`Recursive chunks created: ${allChunks.length}`);

  // Section breakdown
  const sectionCounts = {};
  for (const c of allChunks) {
    sectionCounts[c.section] = (sectionCounts[c.section] || 0) + 1;
  }
  console.log('Section breakdown:');
  for (const [section, count] of Object.entries(sectionCounts)) {
    console.log(`  ${section}: ${count} chunks`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Stopping before embed/insert. Check section breakdown above.');
    console.log(`Chunks with discourse number: ${allChunks.filter(c => c.vachanamrut_number).length}`);

    const withDisc = allChunks.filter(c => c.vachanamrut_number).slice(0, 3);
    const withoutDisc = allChunks.filter(c => !c.vachanamrut_number).slice(0, 2);

    console.log('\nSample chunks WITH discourse number:');
    withDisc.forEach((c, i) => {
      console.log(`\n--- ${i + 1} ---`);
      console.log(`Section: ${c.section} | Page: ${c.page_start} | Discourse: ${c.vachanamrut_number}`);
      console.log(`Content: ${c.content.slice(0, 150)}...`);
    });

    console.log('\nSample chunks WITHOUT discourse number:');
    withoutDisc.forEach((c, i) => {
      console.log(`\n--- ${i + 1} ---`);
      console.log(`Section: ${c.section} | Page: ${c.page_start}`);
      console.log(`Content: ${c.content.slice(0, 150)}...`);
    });

    process.exit(0);
  }

  // Discourse number sample
  const withDiscount = allChunks.filter(c => c.vachanamrut_number);
  console.log(`Chunks with discourse number: ${withDiscount.length}`);
  if (withDiscount.length > 0) {
    const sample = [...new Set(withDiscount.slice(0, 5).map(c => c.vachanamrut_number))];
    console.log('Sample discourse numbers:', sample);
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
          document_id:        doc.id,
          content:            chunk.content,
          content_hash:       chunk.content_hash,
          page_start:         chunk.page_start,
          page_end:           chunk.page_end,
          section:            chunk.section,
          vachanamrut_number: chunk.vachanamrut_number || null,
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