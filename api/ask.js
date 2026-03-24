// Keep this outside the handler so it persists while the server is "warm"
const rateLimitMap = new Map();
const burstLimitMap = new Map();
let lastClearedDate = new Date().toDateString();
const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

function isAllowedOrigin(origin, reqHost) {
  try {
    const url = new URL(origin);
    const sameHost = !!reqHost && url.host === reqHost;
    const inAllowlist = ALLOWED_ORIGINS.has(origin);
    // Allow Vercel preview deployments (project-*.vercel.app) for testing.
    const vercelPreview = url.protocol === 'https:' && url.hostname.endsWith('.vercel.app');
    return sameHost || inAllowlist || vercelPreview;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Origin allowlist check (same-origin and trusted dev/prod origins)
  const origin = req.headers.origin || '';
  const reqHost = req.headers.host || '';
  if (origin && !isAllowedOrigin(origin, reqHost)) {
    return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  }

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

  // 2. Short burst limiter: max 5 requests per 60 seconds per IP
  const now = Date.now();
  const minuteAgo = now - 60000;
  const burstKey = `${ip}_burst`;
  const recentHits = (burstLimitMap.get(burstKey) || []).filter(ts => ts > minuteAgo);
  if (recentHits.length >= 5) {
    burstLimitMap.set(burstKey, recentHits);
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }
  recentHits.push(now);
  burstLimitMap.set(burstKey, recentHits);
    
  // 3. Daily limiter
  const key = `${ip}_${today}`;
  const count = rateLimitMap.get(key) || 0;
  
  if (count >= 3) {
    return res.status(429).json({ error: 'DAILY_LIMIT' });
  }

  // 4. Backend Payload Limit (Important for Cost)
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid message' });
  }
  // Max size set to ~2000 chars (system prompt + user input)
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long' });
  }

  // 5. Upstream request timeout tuned for real-world latency on Vercel
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 25000);
    
    const response = await fetch('https://api.straico.com/v1/prompt/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.STRAICO_KEY
      },
      body: JSON.stringify({
        models: ['deepseek/deepseek-chat-v3-0324'],
        message,
        // Keep output bounded while avoiding truncation in Gujarati responses.
        max_tokens: 550
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || 'Upstream error' });
    }
    
    const data = await response.json();
    // Count only successful completions toward daily quota
    rateLimitMap.set(key, count + 1);
    return res.status(200).json(data);
    
  } catch (err) {
    // 6. Handling Timeout Gracefully
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI took too long to respond. Please try again.' });
    }
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}