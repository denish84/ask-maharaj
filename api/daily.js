import { createClient } from '@supabase/supabase-js';

/**
 * Deterministic “daily wisdom” for the home banner. Picks one chunk per calendar day (IST).
 * Response `content` is `content_clean`: header-stripped, normalized, and excerpted in
 * `scripts/cleanChunks.js` so the UI gets a bounded, sentence-shaped quote (not full `content`).
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/** Same allowlist as api/ask.js (plus ALLOWED_ORIGINS env). */
const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'https://www.ask-maharaj.vercel.app'
]);

function setCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getAllowedOrigins() {
  const envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return new Set([...ALLOWED_ORIGINS, ...envOrigins]);
}

function isAllowedOrigin(origin, req) {
  try {
    const originUrl = new URL(origin);
    const requestHost =
      req.headers['x-forwarded-host'] ||
      req.headers.host ||
      '';

    if (requestHost && originUrl.host === requestHost) {
      return true;
    }

    return getAllowedOrigins().has(origin);
  } catch {
    return false;
  }
}

/**
 * Phrases that signal direct teaching / Maharaj’s words (English + Gujarati).
 * Used for Supabase `or` filter on `content` when picking a daily row.
 */
const TEACHING_PHRASES = [
  'Maharaj said',
  'one should',
  'one must',
  'ought to',
  'a devotee',
  'a devotee must',
  'it is essential',
  'Shriji Maharaj',
  'Maharaj explained',
  'Shriji Maharaj explained',
  'Maharaj stated',
  'Shriji Maharaj stated',
  'મહારાજે કહ્યું',
  'શ્રીજી મહારાજે',
  'કહે છે કે',
  'જોઈએ કે',
  'અનિવાર્ય છે',
  'ભક્તે જોઈએ'
];

const TEACHING_CONTENT_OR = TEACHING_PHRASES.map(
  p => `content.ilike.%${p}%`
).join(',');

/**
 * Applies shared filters for daily chunk selection (count + fetch).
 * Must run on the builder returned by `.select()` — `from()` alone has no `.not()` / `.lt()`.
 * - page_start < 797: drop glossary band (~797–870).
 * - content_clean not ilike '. %': drop fragments starting with mid-sentence punctuation.
 * Note: We intentionally avoid broader preamble exclusions (e.g., '%Samvat year%') to prevent
 * removing valid discourse openings.
 */
function applyDailyChunkFilters(selectBuilder) {
  return selectBuilder
    .not('vachanamrut_number', 'is', null)
    .not('content_clean', 'is', null)
    .lt('page_start', 797)
    .not('content_clean', 'ilike', '. %');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    if (!origin || !isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
    }
    setCorsHeaders(res, origin);
    return res.status(204).end();
  }

  if (req.method !== 'GET') return res.status(405).end();

  const origin = req.headers.origin || '';
  const secFetchSite = (req.headers['sec-fetch-site'] || '').toLowerCase();
  const sameOriginFetch = secFetchSite === 'same-origin' || secFetchSite === 'none';

  if (origin) {
    if (!isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
    }
  } else if (!sameOriginFetch) {
    return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  }
  if (origin) setCorsHeaders(res, origin);

  res.setHeader(
    'Cache-Control',
    's-maxage=86400, stale-while-revalidate=3600'
  );

  // Deterministic seed from today's date (IST) — same chunk all day for all users
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const seed = today.split('-').reduce((a, b) => a + parseInt(b, 10), 0);

  let teachingOnly = true;
  const teachingCountQuery = applyDailyChunkFilters(
    supabase.from('chunks').select('*', { count: 'exact', head: true })
  ).or(TEACHING_CONTENT_OR);
  let { count } = await teachingCountQuery;

  let total = count ?? 0;
  if (total === 0) {
    teachingOnly = false;
    const fallbackQuery = applyDailyChunkFilters(
      supabase.from('chunks').select('*', { count: 'exact', head: true })
    );
    const fallback = await fallbackQuery;
    total = fallback.count ?? 0;
  }

  if (total === 0) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

  const offset = seed % total;

  let rowQuery = applyDailyChunkFilters(
    supabase
      .from('chunks')
      .select('content_clean, section, vachanamrut_number, page_start')
  );
  if (teachingOnly) rowQuery = rowQuery.or(TEACHING_CONTENT_OR);
  const { data, error } = await rowQuery
    .order('id', { ascending: true })
    .range(offset, offset)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

  // Display excerpt only — see scripts/cleanChunks.js (full discourse stays in `content` on the row).
  const content = (data.content_clean || '').trim();

  if (!content) {
    return res.status(500).json({ error: 'No clean content available' });
  }

  return res.status(200).json({
    content,
    section: data.section,
    vachanamrut_number: data.vachanamrut_number,
    page_start: data.page_start,
    date: today
  });
}
