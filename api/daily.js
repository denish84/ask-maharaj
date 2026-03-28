import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Phrases that signal direct teaching / Maharaj’s words (English + Gujarati).
 * Used for Supabase `or` filter and for “skip long history intro” in the handler.
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

/** Drop long printed headings before standard English Vachanamrut date intro (e.g. "Gadhadã I – 74 … In the Samvat year"). */
function stripThroughSamvatIntro(s) {
  const t = s.trim();
  const re = /\bIn the Samvat year\b/i;
  const m = re.exec(t);
  if (!m || m.index <= 0) return t;
  if (m.index > 900) return t;
  return t.slice(m.index).trim();
}

/**
 * If narrative intro is long (>200 chars before first cue), start near teaching:
 * first teaching phrase or opening quote (curly/straight), snapped to sentence or word boundary.
 */
function skipLongHistoryIntro(s) {
  const t = s.trim();
  if (t.length <= 200) return t;

  let anchor = -1;

  const lower = t.toLowerCase();
  for (const phrase of TEACHING_PHRASES) {
    const p = phrase.toLowerCase();
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(p, from)) !== -1) {
      if (idx > 200 && (anchor === -1 || idx < anchor)) anchor = idx;
      from = idx + 1;
    }
  }

  const quoteRe = /[""«]/g;
  let qm;
  while ((qm = quoteRe.exec(t)) !== null) {
    if (qm.index > 200 && (anchor === -1 || qm.index < anchor)) anchor = qm.index;
  }

  if (anchor === -1) return t;

  const start = smartSliceStartBefore(t, anchor);
  return t.slice(start).trim();
}

/** Prefer start after last .!? + space within 120 chars before anchor; else after last space in 80 chars. */
function smartSliceStartBefore(t, anchor) {
  const backMin = Math.max(0, anchor - 120);
  for (let i = anchor - 1; i >= backMin; i--) {
    const ch = t[i];
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(t[i + 1] || '')) {
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j])) j++;
      return j;
    }
  }
  const winMin = Math.max(0, anchor - 80);
  const win = t.slice(winMin, anchor);
  const sp = win.lastIndexOf(' ');
  if (sp !== -1) return winMin + sp + 1;
  return anchor;
}

/** If excerpt starts mid-sentence (lowercase), skip to after the first full stop + capital opener. */
function trimMidSentenceStart(s) {
  const t = s.trim();
  if (t.length < 25) return t;
  if (!/^[a-z]/.test(t)) return t;
  const max = Math.min(t.length, 280);
  for (let i = 15; i < max; i++) {
    if (t[i] !== '.') continue;
    let j = i + 1;
    while (j < t.length && /\s/.test(t[j])) j++;
    if (j < t.length && /[A-Z"“]/.test(t[j])) {
      const rest = t.slice(j).trim();
      if (rest.length >= 40) return rest;
      return t;
    }
  }
  return t;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  // Deterministic seed from today's date (IST) — same chunk all day for all users
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const seed = today.split('-').reduce((a, b) => a + parseInt(b, 10), 0);

  let teachingOnly = true;
  let { count } = await supabase
    .from('chunks')
    .select('*', { count: 'exact', head: true })
    .not('vachanamrut_number', 'is', null)
    .or(TEACHING_CONTENT_OR);

  let total = count ?? 0;
  if (total === 0) {
    teachingOnly = false;
    const fallback = await supabase
      .from('chunks')
      .select('*', { count: 'exact', head: true })
      .not('vachanamrut_number', 'is', null);
    total = fallback.count ?? 0;
  }

  if (total === 0) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

  const offset = seed % total;

  let rowQuery = supabase
    .from('chunks')
    .select('content, section, vachanamrut_number, page_start')
    .not('vachanamrut_number', 'is', null);
  if (teachingOnly) rowQuery = rowQuery.or(TEACHING_CONTENT_OR);
  const { data, error } = await rowQuery
    .order('id', { ascending: true })
    .range(offset, offset)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

  let content = String(data.content || '');

  content = content
    .replace(/^\s*[\p{L}\s]+\s*[IVXivx]*\s*[-–]\s*\d+\s*[-–]\s*/u, '')
    .trim();

  content = stripThroughSamvatIntro(content);
  content = skipLongHistoryIntro(content);

  const capped = content.slice(0, 400);
  const lastPeriod = capped.lastIndexOf('.');
  let excerpt = lastPeriod > 100 ? capped.slice(0, lastPeriod + 1) : capped;
  if (excerpt.length < 150) excerpt = capped;

  content = excerpt;

  content = content
    .replace(/\b\d+\.\d+\s*/g, '')
    .replace(/^\s*(Then|Also|However|But|And|So)\b,?\s*/i, '')
    .trim();

  content = trimMidSentenceStart(content);
  content = content.replace(/\s+/g, ' ').trim();
  content = content.replace(
    /([\p{L}\p{M}\p{N}]+)-\s+([\p{L}\p{M}\p{N}]+)/gu,
    '$1-$2'
  );

  // Trailing Vachanamrut / page-style number leaked into chunk (e.g. " 74." or " 199. ")
  content = content.replace(/\s+\d+[\.\s]*$/, '').trim();

  return res.status(200).json({
    content,
    section: data.section,
    vachanamrut_number: data.vachanamrut_number,
    page_start: data.page_start,
    date: today
  });
}
