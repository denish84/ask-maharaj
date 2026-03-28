import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * PostgREST OR of ilike filters — teaching / direct-instruction cues (English + Gujarati).
 * Avoids bare "explained"/"stated" (too much narrative).
 */
const TEACHING_CONTENT_OR = [
  'content.ilike.%Maharaj said%',
  'content.ilike.%one should%',
  'content.ilike.%one must%',
  'content.ilike.%ought to%',
  'content.ilike.%a devotee%',
  'content.ilike.%a devotee must%',
  'content.ilike.%it is essential%',
  'content.ilike.%Shriji Maharaj%',
  'content.ilike.%Maharaj explained%',
  'content.ilike.%Shriji Maharaj explained%',
  'content.ilike.%Maharaj stated%',
  'content.ilike.%Shriji Maharaj stated%',
  'content.ilike.%મહારાજે કહ્યું%',
  'content.ilike.%શ્રીજી મહારાજે%',
  'content.ilike.%કહે છે કે%',
  'content.ilike.%જોઈએ કે%',
  'content.ilike.%અનિવાર્ય છે%',
  'content.ilike.%ભક્તે જોઈએ%'
].join(',');

/** Drop long printed headings before standard English Vachanamrut date intro (e.g. "Gadhadã I – 74 … In the Samvat year"). */
function stripThroughSamvatIntro(s) {
  const t = s.trim();
  const re = /\bIn the Samvat year\b/i;
  const m = re.exec(t);
  if (!m || m.index <= 0) return t;
  if (m.index > 900) return t;
  return t.slice(m.index).trim();
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

  // Clean full chunk first so we don't slice away anchors like "In the Samvat year"
  let content = String(data.content || '');

  // Strip leading discourse header (e.g. "GADHADĀ I - 181 - ") that PDF ingest left on the chunk
  content = content
    .replace(/^\s*[\p{L}\s]+\s*[IVXivx]*\s*[-–]\s*\d+\s*[-–]\s*/u, '')
    .trim();

  content = stripThroughSamvatIntro(content);

  // Trim to first 400 chars at sentence boundary (after structural strips)
  content = content.slice(0, 400);
  const lastPeriod = content.lastIndexOf('.');
  if (lastPeriod > 100) content = content.slice(0, lastPeriod + 1);

  content = content
    .replace(/\b\d+\.\d+\s*/g, '') // footnote-style refs (e.g. 35.7); word-boundary avoids glued digits
    .replace(/^\s*(Then|Also|However|But|And|So)\b,?\s*/i, '')
    .trim();

  content = trimMidSentenceStart(content);
  content = content.replace(/\s+/g, ' ').trim();
  content = content.replace(
    /([\p{L}\p{M}\p{N}]+)-\s+([\p{L}\p{M}\p{N}]+)/gu,
    '$1-$2'
  ); // e.g. "Gangã- water" → "Gangã-water" (PDF line-break hyphen)

  return res.status(200).json({
    content,
    section: data.section,
    vachanamrut_number: data.vachanamrut_number,
    page_start: data.page_start,
    date: today
  });
}
