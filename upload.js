const fs = require('fs');
const https = require('https');
const path = require('path');

const apiKey = '7T-DDtwpsEzmeJifqThjw728c0L0JYrzclziqe5DC2hVLzWtkRg';
const boundary = '----FormBoundary7MA4YWxkTrZu0gW';

function buildMultipartBody(fileName, ragName) {
  const filePath = path.join(__dirname, fileName);
  const file = fs.readFileSync(filePath);

  const bodyStart = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="name"\r\n\r\n' +
    ragName + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="description"\r\n\r\n' +
    'Vachanamrut scripture\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="files"; filename="' + fileName + '"\r\n' +
    'Content-Type: text/plain\r\n\r\n'
  );

  const bodyEnd = Buffer.from('\r\n--' + boundary + '--\r\n');
  return Buffer.concat([bodyStart, file, bodyEnd]);
}

function uploadRag(fileName, ragName) {
  const fullBody = buildMultipartBody(fileName, ragName);

  const options = {
    hostname: 'api.straico.com',
    path: '/v0/rag',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': fullBody.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          /* leave parsed null */
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        resolve({ raw: data, parsed });
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

(async () => {
  const ragIds = [];

  for (let i = 1; i <= 5; i++) {
    const fileName = `vachanamrut-part${i}.txt`;
    const ragName = `vachanamrut-rag-part${i}`;

    console.log(`Uploading ${fileName}…`);
    try {
      const { raw, parsed } = await uploadRag(fileName, ragName);
      console.log('Response:', raw);

      const id = parsed?.data?._id || parsed?.data?.id || parsed?._id || '';
      if (!id) {
        throw new Error('No RAG ID in response: ' + raw);
      }
      ragIds.push(id);
      console.log(`RAG ID (${fileName}):`, id);
    } catch (e) {
      console.error(`Failed on ${fileName}:`, e.message);
      process.exit(1);
    }
  }

  console.log('\nAll 5 RAG IDs:');
  console.log(ragIds.join('\n'));
})();
