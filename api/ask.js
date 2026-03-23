const rateLimitMap = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // IP-based rate limit — 3 requests per day per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
  const today = new Date().toDateString();
  const key = `${ip}_${today}`;
  const count = rateLimitMap.get(key) || 0;

  if (count >= 3) {
    return res.status(429).json({ error: 'DAILY_LIMIT' });
  }
  rateLimitMap.set(key, count + 1);

  // Forward to Straico
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  try {
    const response = await fetch('https://api.straico.com/v1/prompt/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.STRAICO_KEY
      },
      body: JSON.stringify({
        models: ['deepseek/deepseek-chat-v3-0324'],
        message
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || 'Upstream error' });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
