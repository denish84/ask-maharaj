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
 * Leading discourse header, including optional title after the number, e.g.
 * Gadhadã I – 71 Bhagvãn Incarnates… (same line or before a newline).
 */
const LEADING_HEADER_RE =
  /^\s*[\p{L}\p{M}\s,']+?\s*[IVXivx]*\s*[-–]\s*\d+\s*[-–]?\s*[\p{L}\p{M}\s,']*\n?/u;

/** Footnote-style refs like 35.7 */
const FOOTNOTE_RE = /\b\d+\.\d+\s*/gu;

/** Hyphenated word split across line break: Gangã- water → Gangã-water */
const HYPHEN_BREAK_RE = /([\p{L}\p{M}\p{N}]+)-\s+([\p{L}\p{M}\p{N}]+)/gu;

/** If text opens with lowercase, jump to first capital after a sentence-ending period. */
function trimMidSentenceAfterPeriod(s) {
  const t = s.trim();
  if (!t.length) return t;
  if (!/^\p{Ll}/u.test(t)) return t;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '.') continue;
    let j = i + 1;
    while (j < t.length && /\s/.test(t[j])) j++;
    const rest = t.slice(j);
    if (rest.length && /^\p{Lu}/u.test(rest)) return rest.trim();
  }
  return t;
}

function capitalizeFirstLetter(s) {
  if (!s) return s;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = ch.length === 2 ? 2 : 1;
    if (/\p{L}/u.test(ch)) {
      return s.slice(0, i) + ch.toUpperCase() + s.slice(i + w);
    }
    i += w;
  }
  return s;
}

function cleanContent(original) {
  const rawOriginal = String(original ?? '');
  let s = rawOriginal;

  s = s.replace(LEADING_HEADER_RE, '').trim();
  s = s.replace(/^\s*[-–]\s*\d+\s*[-–]?\s*/u, '').trim();
  s = s.replace(FOOTNOTE_RE, '');
  s = s.replace(HYPHEN_BREAK_RE, '$1-$2');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\s+([.,])/g, '$1');
  s = trimMidSentenceAfterPeriod(s);
  s = s.replace(/^\s*(Then|Also|However|But|And|So)\b,?\s*/i, '');
  s = s.trim();
  if (s.length) s = capitalizeFirstLetter(s);
  s = s.trim();

  const usedFallback = s.length < MIN_CLEAN_LEN;
  const finalText = usedFallback ? rawOriginal : s;
  return { finalText, usedFallback, cleanedLen: s.length };
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
      '--show-fallbacks: will log full original `content` for every row where cleaned text is <',
      MIN_CLEAN_LEN,
      'chars.'
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
        const tag = usedFallback ? ' [FALLBACK: cleaned < ' + MIN_CLEAN_LEN + ' chars → keep original]' : '';
        console.log(`\n--- Sample ${samplesLogged}/${sampleLogs}  id=${row.id}${tag}`);
        const before = String(row.content ?? '');
        console.log(
          'BEFORE (first 220 chars):\n',
          before.slice(0, 220) + (before.length > 220 ? '…' : '')
        );
        console.log(
          'AFTER (first 450 chars):\n',
          finalText.slice(0, 450) + (finalText.length > 450 ? '…' : '')
        );
      }

      if (!dryRun) {
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
      } else {
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
      `\nDry run finished. Would update ${updated} rows; ${skippedShort} would use original fallback (cleaned < ${MIN_CLEAN_LEN} chars); fetch failures: ${failed}. No writes performed.`
    );
  } else {
    console.log(
      `Done. Updated: ${updated}, skipped (cleaned < ${MIN_CLEAN_LEN} chars, used original): ${skippedShort}, failed: ${failed}`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
