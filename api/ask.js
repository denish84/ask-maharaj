const rateLimitMap = new Map(); // in-memory, resets on cold start — good enough

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Simple IP-based rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const today = new Date().toDateString();
  const key = `${ip}_${today}`;

  const count = rateLimitMap.get(key) || 0;
  if (count >= 3) {
    return res.status(429).json({ error: 'DAILY_LIMIT' });
  }
  rateLimitMap.set(key, count + 1);

  const { message } = req.body;

  const response = await fetch('https://api.straico.com/v1/prompt/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.STRAICO_KEY  // ← from env, never client
    },
    body: JSON.stringify({
      models: ['deepseek/deepseek-chat-v3-0324'],
      message
    })
  });

  const data = await response.json();
  res.status(200).json(data);
}
