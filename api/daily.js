import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  // Deterministic seed from today's date (IST) — same chunk all day for all users
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const seed = today.split('-').reduce((a, b) => a + parseInt(b, 10), 0);

  const { count } = await supabase
    .from('chunks')
    .select('*', { count: 'exact', head: true })
    .not('vachanamrut_number', 'is', null);

  const offset = seed % (count || 1);

  const { data, error } = await supabase
    .from('chunks')
    .select('content, section, vachanamrut_number, page_start')
    .not('vachanamrut_number', 'is', null)
    .order('id', { ascending: true })
    .range(offset, offset)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Could not fetch daily teaching' });
  }

  // Trim content to first 300 chars at sentence boundary
  let content = data.content.slice(0, 300);
  const lastPeriod = content.lastIndexOf('.');
  if (lastPeriod > 100) content = content.slice(0, lastPeriod + 1);

  return res.status(200).json({
    content,
    section: data.section,
    vachanamrut_number: data.vachanamrut_number,
    page_start: data.page_start,
    date: today
  });
}
