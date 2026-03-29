import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    .select('content_clean, section, vachanamrut_number, page_start')
    .not('vachanamrut_number', 'is', null);
  if (teachingOnly) rowQuery = rowQuery.or(TEACHING_CONTENT_OR);
  const { data, error } = await rowQuery
    .order('id', { ascending: true })
    .range(offset, offset)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

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
