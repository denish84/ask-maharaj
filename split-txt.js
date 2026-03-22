const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, 'vachanamrut.txt');
const text = fs.readFileSync(inputPath, 'utf8');

const n = 5;
const totalLen = text.length;
const base = Math.floor(totalLen / n);
const remainder = totalLen % n;

let offset = 0;
for (let i = 0; i < n; i++) {
  const chunkLen = base + (i < remainder ? 1 : 0);
  const part = text.slice(offset, offset + chunkLen);
  offset += chunkLen;

  const outName = `vachanamrut-part${i + 1}.txt`;
  const outPath = path.join(__dirname, outName);
  fs.writeFileSync(outPath, part, 'utf8');

  const words = part.trim().split(/\s+/).filter(Boolean);
  console.log(`${outName}: ${words.length} words`);
}
