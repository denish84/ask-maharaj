/**
 * Batch-writes `content_clean` on `chunks`: strips PDF noise (headers, section markers, etc.),
 * then builds a readable excerpt capped near EXCERPT_MAX and trimmed to a sentence end when possible.
 * Used by the site’s daily banner (`api/daily.js`) and anywhere else that prefers a short quote.
 *
 * Run: `node scripts/cleanChunks.js` (use `--dry-run` to sample without updating).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BATCH = 100;
const MIN_CLEAN_LEN = 50;
const DEFAULT_SAMPLE_LOGS = 12;

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const showFallbacks = argv.includes('--show-fallbacks');
  const samplesArg = argv.find(a => a.startsWith('--samples='));
  let sampleLogs = DEFAULT_SAMPLE_LOGS;
  if (samplesArg) {
    const n = parseInt(samplesArg.split('=')[1], 10);
    if (!Number.isNaN(n)) sampleLogs = Math.min(50, Math.max(1, n));
  }
  return { dryRun, sampleLogs, showFallbacks };
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Just the loud page/header prefix, e.g.
 * GADHADÃ I - 182 -
 * KÃRIYÃNI - 297 -
 * LOYÃ - 310 -
 *
 * Important: this intentionally stops at the trailing separator so it does NOT
 * swallow real content like "veranda outside the north-facing rooms..."
 */
const LEADING_HEADER_RE =
  /^\s*[\p{Lu}\p{M}]+(?:\s+[\p{Lu}\p{M}]+)*(?:\s+[IVXivx]+)?\s*[-–]\s*\d+\s*[-–]\s*/u;

/**
 * A discourse-title block left after the page header, only when it is clearly
 * followed by a section marker or the "In the Samvat year" opener, e.g.
 * Gadhadã I – 71 Bhagvãn Incarnates With His Akshardhãm 71.1 ...
 */
const LEADING_TITLE_RE =
  /^\s*[\p{L}\p{M}\s,'\u2019]+?\s*[–-]\s*\d+\s+[\p{L}\p{M}\s,'\u2019]+(?=\s+\d+\.\d+\s|\s+In the Samvat year\b)/u;

/** Leading section marker such as "71.1 ", "10.8 ", or leftover "– 71 " */
const LEADING_SECTION_RE = /^\s*(?:[–—-]\s*)?\d{1,3}(?:\.\d+)?\s+/u;

/** Orphan leading punctuation left after stripping */
const LEADING_ORPHAN_PUNCT_RE = /^\s*[.:-–—]+\s+/u;

/** Footnote-style refs like 35.7 */
const FOOTNOTE_RE = /\b\d+\.\d+\s*/gu;

/** Hyphenated word split across line break: Gangã- water → Gangã-water */
const HYPHEN_BREAK_RE = /([\p{L}\p{M}\p{N}]+)-\s+([\p{L}\p{M}\p{N}]+)/gu;

/**
 * PDF/footer glue: tail of one discourse + "|| End of Vachanãmrut …" + next discourse header.
 * Drop from the marker onward (any spelling between Vachan…mrut).
 */
const END_OF_VACH_RE =
  /(?:\s*\|\|\s*)?End\s+of\s+Vachan.*?mrut\b[\s\S]*/iu;

/** If a chunk concatenated two English openers, keep only the first discourse */
function truncateBeforeSecondSamvat(str) {
  const re = /\bIn the Samvat year\b/gi;
  const indices = [];
  let m;
  while ((m = re.exec(str)) !== null) {
    indices.push(m.index);
    if (indices.length >= 2) break;
  }
  if (indices.length < 2) return str;
  const second = indices[1];
  if (second < 400) return str;
  return str.slice(0, second).trim();
}

/** `Bhagvãn .` → `Bhagvãn.` (common PDF spacing before closing punctuation) */
const SPACE_BEFORE_SENTENCE_END_RE = /(?<=[\p{L}\p{M}\p{N}])\s+([.!?])(?=\s|$|[\u201d")])/gu;

/** Max chars considered when choosing a sentence boundary for the excerpt */
const EXCERPT_MAX = 1100;
/** If the only `.`/`!`/`?` in the head is before this index (e.g. after “greatness.”), scan further — many teachings use `;` between clauses and only end with `.` later */
const LEAD_IN_IGNORE = 200;
/** When no suitable sentence end exists, trim to this length at a word boundary */
const HARD_FALLBACK = 900;

function lastSentenceEnd(str) {
  return Math.max(
    str.lastIndexOf('.'),
    str.lastIndexOf('!'),
    str.lastIndexOf('?')
  );
}

/** Produce excerpt for UI; returns null if result is too short (see MIN_CLEAN_LEN). */
function cleanContent(original) {
  let s = String(original ?? '');

  s = s.replace(/\u00ad/g, '');
  s = s.replace(END_OF_VACH_RE, '').trim();

  const samvatMatch = s.match(/\bIn the Samvat year\b/i);
  if (samvatMatch?.index > 0 && samvatMatch.index < 2200) {
    s = s.slice(samvatMatch.index).trim();
  } else {
    s = s.replace(LEADING_HEADER_RE, '').trim();
    s = s.replace(LEADING_TITLE_RE, '').trim();
  }

  s = s.replace(LEADING_SECTION_RE, '').trim();
  s = s.replace(FOOTNOTE_RE, '');
  s = s.replace(HYPHEN_BREAK_RE, '$1-$2');
  s = s.replace(LEADING_ORPHAN_PUNCT_RE, '').trim();
  s = s.replace(/\s+/g, ' ');
  s = truncateBeforeSecondSamvat(s);
  s = s.replace(SPACE_BEFORE_SENTENCE_END_RE, '$1');

  const head = s.slice(0, EXCERPT_MAX);
  let lastEnd = lastSentenceEnd(head);

  if (lastEnd < LEAD_IN_IGNORE) {
    const tail = s.slice(LEAD_IN_IGNORE, EXCERPT_MAX);
    const rel = lastSentenceEnd(tail);
    if (rel >= 0) {
      lastEnd = LEAD_IN_IGNORE + rel;
    }
  }

  let result;
  if (lastEnd >= LEAD_IN_IGNORE) {
    result = s.slice(0, lastEnd + 1).trim();
  } else {
    result =
      s.slice(0, HARD_FALLBACK).replace(/\s+\S+$/, '') + '…';
  }

  const finalized = result.trim();
  const usedFallback = finalized.length < MIN_CLEAN_LEN;

  return {
    finalText: usedFallback ? null : finalized,
    usedFallback,
    cleanedLen: finalized.length
  };
}

async function main() {
  const { dryRun, sampleLogs, showFallbacks } = parseArgs(process.argv.slice(2));
  if (dryRun) {
    console.log(
      'DRY RUN — no Supabase updates. Logging up to',
      sampleLogs,
      'samples (use --samples=15 to change).'
    );
  }
  if (showFallbacks) {
    console.log(
      '--show-fallbacks: will log full original `content` for every row where clean result is <',
      MIN_CLEAN_LEN,
      'chars (finalText will be null).'
    );
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const { count, error: countErr } = await supabase
    .from('chunks')
    .select('id', { count: 'exact', head: true })
    .not('vachanamrut_number', 'is', null);

  if (countErr) {
    console.error('Count failed:', countErr.message);
    process.exit(1);
  }

  const total = count ?? 0;
  if (total === 0) {
    console.log('No rows with vachanamrut_number set.');
    return;
  }

  console.log(`Total rows to process: ${total}`);

  let updated = 0;
  let skippedShort = 0;
  let failed = 0;
  let processed = 0;
  let samplesLogged = 0;

  for (let from = 0; from < total; from += BATCH) {
    const to = Math.min(from + BATCH - 1, total - 1);

    const { data: rows, error: fetchErr } = await supabase
      .from('chunks')
      .select('id, content')
      .not('vachanamrut_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, to);

    if (fetchErr) {
      console.error(`Fetch failed at range ${from}-${to}:`, fetchErr.message);
      failed += Math.min(BATCH, total - from);
      processed += Math.min(BATCH, total - from);
      continue;
    }

    if (!rows?.length) break;

    for (const row of rows) {
      const { finalText, usedFallback, cleanedLen } = cleanContent(row.content);

      const suspiciousStart =
        finalText != null && /^[.()\-–—]/.test(finalText);
      if (dryRun && suspiciousStart) {
        console.log(`\n[SUSPICIOUS START] id=${row.id}`);
        console.log(finalText.slice(0, 180));
      }

      if (usedFallback) skippedShort++;

      if (showFallbacks && usedFallback) {
        const before = String(row.content ?? '');
        console.log(
          `\n========== FALLBACK id=${row.id} cleanedLen=${cleanedLen} (threshold ${MIN_CLEAN_LEN}) ==========\n` +
            before +
            `\n========== END FALLBACK id=${row.id} ==========\n`
        );
      }

      if (dryRun && samplesLogged < sampleLogs) {
        samplesLogged++;
        const tag = usedFallback
          ? ' [FALLBACK: cleaned < ' + MIN_CLEAN_LEN + ' chars → finalText null]'
          : '';
        console.log(`\n--- Sample ${samplesLogged}/${sampleLogs}  id=${row.id}${tag}`);
        const before = String(row.content ?? '');
        console.log(
          'BEFORE (first 220 chars):\n',
          before.slice(0, 220) + (before.length > 220 ? '…' : '')
        );
        console.log(
          'AFTER (first 450 chars):\n',
          finalText == null
            ? '(null — below threshold)'
            : finalText.slice(0, 450) + (finalText.length > 450 ? '…' : '')
        );
      }

      if (!dryRun) {
        if (finalText === null) {
          continue;
        }
        const { error: upErr } = await supabase
          .from('chunks')
          .update({ content_clean: finalText })
          .eq('id', row.id);

        if (upErr) {
          console.error(`Update failed id=${row.id}:`, upErr.message);
          failed++;
        } else {
          updated++;
        }
      } else if (finalText !== null) {
        updated++;
      }
    }

    processed += rows.length;
    if (processed % BATCH === 0 || processed === total) {
      console.log(`Processed ${processed}/${total}...`);
    }
  }

  if (dryRun) {
    console.log(
      `\nDry run finished. Would update ${updated} rows; ${skippedShort} below threshold (finalText null, no write); fetch failures: ${failed}. No writes performed.`
    );
  } else {
    console.log(
      `Done. Updated: ${updated}, skipped (cleaned < ${MIN_CLEAN_LEN} chars, finalText null, DB unchanged): ${skippedShort}, failed: ${failed}`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
