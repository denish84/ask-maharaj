const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const inputPath = path.join(__dirname, 'vachnamrut-english.pdf');
const outputPath = path.join(__dirname, 'vachanamrut.txt');

(async () => {
  const dataBuffer = fs.readFileSync(inputPath);
  const data = await pdf(dataBuffer);
  fs.writeFileSync(outputPath, data.text, 'utf8');
  const words = data.text.trim().split(/\s+/).filter(Boolean);
  console.log('Words extracted:', words.length);
  console.log('Saved to:', outputPath);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
