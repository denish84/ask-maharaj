/**
 * Validate JSON and copy into data/daily-quotes.json (UTF-8).
 * Use when your quotes live in another file (e.g. saved from chat).
 *
 *   node scripts/copy-daily-quotes.js C:\path\to\your-quotes.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

const srcArg = process.argv[2];
if (!srcArg) {
  console.error('Usage: node scripts/copy-daily-quotes.js <path-to-json-array>');
  process.exit(1);
}

const src = isAbsolute(srcArg) ? srcArg : join(process.cwd(), srcArg);
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'daily-quotes.json');

let raw;
try {
  raw = readFileSync(src, 'utf8');
} catch (e) {
  console.error('Cannot read:', src, e.message);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('Invalid JSON:', e.message);
  process.exit(1);
}

if (!Array.isArray(data) || data.length === 0) {
  console.error('File must be a non-empty JSON array');
  process.exit(1);
}

writeFileSync(dest, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('Wrote', dest, '(' + data.length + ' items). Next: npm run import-daily-quotes');
