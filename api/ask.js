// Keep this outside the handler so it persists while the server is "warm"
const rateLimitMap = new Map();
let lastClearedDate = new Date().toDateString();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const today = new Date().toDateString();
  
  // Memory Leak Fix: Automatically wipe the entire map at midnight
  // so the server's memory doesn't fill up over weeks/months
  if (today !== lastClearedDate) {
    rateLimitMap.clear();
    lastClearedDate = today;
  }

  // 1. Better IP Extraction
  const ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';
    
  // 2. The Free "Good Enough" Rate Limit
  const key = `${ip}_${today}`;
  const count = rateLimitMap.get(key) || 0;
  
  if (count >= 3) {
    return res.status(429).json({ error: 'DAILY_LIMIT' });
  }
  rateLimitMap.set(key, count + 1);

  // 3. Backend Payload Limit (Important for Cost)
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid message' });
  }
  // Max size set to ~2000 chars (system prompt + user input)
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long' });
  }

  // 4. The Request with Your 10s AbortController
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://api.straico.com/v1/prompt/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.STRAICO_KEY
      },
      body: JSON.stringify({
        models: ['deepseek/deepseek-chat-v3-0324'],
        message,
        // Optional but recommended: Add max_tokens to prevent the AI from generating an entire book and costing you credits
        max_tokens: 300 
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || 'Upstream error' });
    }
    
    const data = await response.json();
    return res.status(200).json(data);
    
  } catch (err) {
    // 5. Handling Timeout Gracefully
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI took too long to respond. Please try again.' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
}