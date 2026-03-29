import { createClient } from '@supabase/supabase-js';

/**
 * Daily wisdom for the home banner (IST date seed).
 * 1) If `daily_quotes` has rows → manual curated quotes (`data/daily-quotes.json` + import script).
 * 2) Else → `chunks.content_clean` — see `scripts/cleanChunks.js`.
 * QA: `GET /api/daily?shuffle=1` randomizes within whichever source is active.
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
 * - Drop obvious PDF glue / multi-discourse junk still present in some rows.
 */
function applyDailyChunkFilters(selectBuilder) {
  return selectBuilder
    .not('vachanamrut_number', 'is', null)
    .not('content_clean', 'is', null)
    .lt('page_start', 797)
    .not('content_clean', 'ilike', '. %')
    .not('content_clean', 'ilike', '%||%')
    .not('content_clean', 'ilike', '%End of Vachan%');
}

function wantsShuffle(req) {
  const q = req.query;
  if (q && (q.shuffle === '1' || q.shuffle === 'true')) return true;
  const raw = req.url || '';
  const i = raw.indexOf('?');
  if (i === -1) return false;
  const params = new URLSearchParams(raw.slice(i).split('#')[0]);
  return params.get('shuffle') === '1' || params.get('shuffle') === 'true';
}

/** Manual quotes table — see supabase/daily_quotes.sql */
async function tryCuratedDaily(seed, shuffle, today) {
  const { count, error: countErr } = await supabase
    .from('daily_quotes')
    .select('*', { count: 'exact', head: true });

  if (countErr || count == null || count === 0) {
    return null;
  }

  const total = count;
  const offset = shuffle
    ? Math.floor(Math.random() * total)
    : seed % total;

  const { data, error } = await supabase
    .from('daily_quotes')
    .select(
      'quote_text, quote_text_gu, theme_title, theme_title_gu, citation, vachanamrut_number, page_start'
    )
    .order('sort_order', { ascending: true })
    .range(offset, offset)
    .single();

  if (error || !data) {
    return null;
  }

  const content = (data.quote_text || '').trim();
  if (!content) {
    return null;
  }

  const quote_text_gu = (data.quote_text_gu || '').trim() || null;

  return {
    content,
    quote_text_gu,
    theme_title: data.theme_title?.trim() || null,
    theme_title_gu: data.theme_title_gu?.trim() || null,
    citation: data.citation?.trim() || null,
    vachanamrut_number: data.vachanamrut_number ?? null,
    page_start: data.page_start ?? null,
    section: null,
    date: today,
    curated: true,
    ...(shuffle ? { shuffle: true } : {})
  };
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

  const shuffle = wantsShuffle(req);
  if (shuffle) {
    res.setHeader(
      'Cache-Control',
      'private, no-store, no-cache, must-revalidate'
    );
  } else {
    res.setHeader(
      'Cache-Control',
      's-maxage=86400, stale-while-revalidate=3600'
    );
  }

  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const seed = today.split('-').reduce((a, b) => a + parseInt(b, 10), 0);

  const curated = await tryCuratedDaily(seed, shuffle, today);
  if (curated) {
    return res.status(200).json(curated);
  }

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

  const offset = shuffle
    ? Math.floor(Math.random() * total)
    : seed % total;

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
    date: today,
    curated: false,
    ...(shuffle ? { shuffle: true } : {})
  });
}
