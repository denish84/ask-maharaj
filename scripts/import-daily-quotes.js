/**
 * Upserts rows into public.daily_quotes from data/daily-quotes.json
 *
 * Default: data/daily-quotes.json — or: node scripts/import-daily-quotes.js ./path/to/quotes.json
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 *
 * Run: node scripts/import-daily-quotes.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON = join(__dirname, '..', 'data', 'daily-quotes.json');
const argPath = process.argv[2];
const JSON_PATH = argPath
  ? isAbsolute(argPath)
    ? argPath
    : join(process.cwd(), argPath)
  : DEFAULT_JSON;

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  if (!existsSync(JSON_PATH)) {
    console.error(
      'Missing file:',
      JSON_PATH,
      '\nCopy data/daily-quotes.example.json to data/daily-quotes.json and add your quotes.'
    );
    process.exit(1);
  }

  let rows;
  try {
    rows = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  } catch (e) {
    console.error('Invalid JSON:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    console.error('daily-quotes.json must be a non-empty array');
    process.exit(1);
  }

  let normalized;
  try {
    normalized = rows.map((r, i) => {
      const sort_order =
        typeof r.sort_order === 'number' && !Number.isNaN(r.sort_order)
          ? r.sort_order
          : i;
      const quote_text = String(r.quote_text ?? '').trim();
      if (!quote_text) {
        throw new Error(`Row ${i}: quote_text is required`);
      }
      return {
        sort_order,
        quote_text,
        quote_text_gu:
          r.quote_text_gu != null ? String(r.quote_text_gu).trim() || null : null,
        theme_title: r.theme_title != null ? String(r.theme_title).trim() || null : null,
        theme_title_gu:
          r.theme_title_gu != null ? String(r.theme_title_gu).trim() || null : null,
        citation: r.citation != null ? String(r.citation).trim() || null : null,
        vachanamrut_number:
          r.vachanamrut_number != null
            ? String(r.vachanamrut_number).trim() || null
            : null,
        page_start: (() => {
          if (r.page_start == null || r.page_start === '') return null;
          const n = parseInt(String(r.page_start), 10);
          return Number.isFinite(n) ? n : null;
        })()
      };
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const orders = new Set();
  for (const r of normalized) {
    if (orders.has(r.sort_order)) {
      console.error('Duplicate sort_order:', r.sort_order);
      process.exit(1);
    }
    orders.add(r.sort_order);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error } = await supabase
    .from('daily_quotes')
    .upsert(normalized, { onConflict: 'sort_order' });

  if (error) {
    console.error('Upsert failed:', error.message);
    console.error(
      'Did you run supabase/daily_quotes.sql in the SQL editor first?'
    );
    process.exit(1);
  }
  console.log('Upserted', normalized.length, 'rows into daily_quotes.');
}

main();
