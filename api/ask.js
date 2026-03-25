// Keep this outside the handler so it persists while the server is "warm"
const rateLimitMap = new Map();
const burstLimitMap = new Map();
let lastClearedDate = new Date().toDateString();
const MAX_QUESTION_CHARS = 4000;
const MAX_REQUEST_BYTES = 64 * 1024;
/** Must match the client daily cap in index.html (`amDailyLimit` / limit messages). */
const DAILY_QUESTION_LIMIT = 20;
const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'https://www.ask-maharaj.vercel.app'
]);
const SYSTEM_PROMPT = `You are a humble, wise, and deeply knowledgeable Satsang guide. Your purpose is to help modern devotees overcome daily life challenges by applying the pure teachings of Bhagwan Swaminarayan, specifically from the Vachanamrut and Swamini Vato.

Core Directives:
- You must ONLY draw upon the philosophy of the Swaminarayan Sampraday (Agna, Upasana, Bhakti, Gnan, and Vairagya). Do not include western self-help, generic motivation, or other philosophies.
- If the answer cannot be clearly derived from Vachanamrut or Swamini Vato, respond with: This is not directly explained in the Vachanamrut or Swamini Vato.
- Citation Rule (STRICT - Zero Hallucination):
NEVER cite a specific Vachanamrut number (like Gadhada I-21) unless you are 100% certain.
When uncertain, ALWAYS say:
'In the Vachanamrut, Shriji Maharaj explains...'
or
'Gunatitanand Swami notes in his Vato...'
It is FAR better to say no specific citation than to give a wrong one. Wrong citations will cause serious harm to the Satsang community's trust.
- Be compassionate and relatable to modern youth but always guide them toward spiritual truth.

Formatting Rules:
- Always begin with: Jai Swaminarayan. (In Gujarati answers, use જય સ્વામિનારાયણ. instead.)
- Target 200-300 words. This is enough for one empathy line, a Teaching paragraph of 3-4 sentences, 3-4 complete practical bullets, and a closing line. Never sacrifice Teaching depth or cut a bullet mid-sentence to stay short.
- Structure: 1. Empathy (1 line) 2. Teaching (scripture-based) 3. Practical application
- Include key terms like Antahkaran (inner mind), Maya (illusion), Kusang (bad influence), Mahima (divine glory) with brief explanations
- Gujarati language quality (when the answer is in Gujarati):
  - Use natural, warm devotional Gujarati; avoid stiff literal translations from English.
  - Open with exactly: જય સ્વામિનારાયણ. (never misspell as જૈ or similar).
  - Use respectful તમે consistently; do not mix તું.
  - Keep spellings steady: અંતઃકરણ, માયા, કુસંગ, મહિમા, જ્ઞાન, આજ્ઞા, ઉપાસના, ભક્તિ, વૈરાગ્ય, સત્સંગ, વચનામૃત, સ્વામિની વાતો.
  - Prefer short clear sentences; do not repeat the same name or phrase every line.
  - One clear action per bullet in the practical section.
  - For Ekadashi or fasting, prefer નિયમપૂર્વક ફરાળી / શારીરિક ક્ષમતા મુજબ over vague "સાત્વિક ભોજન" alone.
  - If a point is general Hindu tradition rather than a precise Vachanamrut line, soften it (e.g. સત્સંગ પરંપરામાં સમજવામાં આવે છે...) instead of stating as absolute scriptural fact.
- Finish all numbered points and bullet points completely; never end mid-sentence or mid-list.
- Avoid generic motivational advice
- End with a humble line such as: May Maharaj give you the strength to...`;

const LANG_SUFFIXES = {
  en: 'IMPORTANT: You must answer in English only.',
  gu:
    'IMPORTANT: You must answer in Gujarati script only. Every single character in your response must be Gujarati Unicode (U+0A80–U+0AFF) or standard punctuation. Do not use any Latin, Devanagari, Cyrillic, or any other script characters anywhere in your response, including inside headings and bullet points.'
};

function setCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getAllowedOrigins() {
  const envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return new Set([...ALLOWED_ORIGINS, ...envOrigins]);
}

function isAllowedOrigin(origin, req) {
  try {
    const originUrl = new URL(origin);
    const requestHost =
      req.headers['x-forwarded-host'] ||
      req.headers.host ||
      '';

    // Always allow same-host requests (production, preview, custom domain).
    if (requestHost && originUrl.host === requestHost) {
      return true;
    }

    // Explicit allowlist fallback for cross-origin use-cases.
    return getAllowedOrigins().has(origin);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const secFetchSite = (req.headers['sec-fetch-site'] || '').toLowerCase();
  const sameOriginFetch = secFetchSite === 'same-origin' || secFetchSite === 'none';

  if (req.method === 'OPTIONS') {
    if (!origin || !isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
    }
    setCorsHeaders(res, origin);
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).end();
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return res.status(413).json({
      error: 'QUESTION_TOO_LONG',
      max_question_chars: MAX_QUESTION_CHARS
    });
  }

  if (!process.env.STRAICO_KEY) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED: Missing STRAICO_KEY' });
  }

  // CSRF protection: allow valid Origin OR trusted same-origin fetch metadata.
  if (origin) {
    if (!isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
    }
  } else if (!sameOriginFetch) {
    return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  }
  if (origin) setCorsHeaders(res, origin);

  const today = new Date().toDateString();
  
  // Memory: wipe limiter maps when the calendar day changes so entries from old
  // IPs / clients do not accumulate unbounded on a warm instance.
  if (today !== lastClearedDate) {
    rateLimitMap.clear();
    burstLimitMap.clear();
    lastClearedDate = today;
  }

  // 1. Better IP Extraction
  const ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const userAgent = (req.headers['user-agent'] || '').slice(0, 120);
  const acceptLang = (req.headers['accept-language'] || '').slice(0, 64);
  const clientKey = `${ip}|${userAgent}|${acceptLang}`;

  // 2. Short burst limiter: max 15 requests per 60 seconds per IP
  const now = Date.now();
  const minuteAgo = now - 60000;
  const burstKey = `${clientKey}_burst`;
  const recentHits = (burstLimitMap.get(burstKey) || []).filter(ts => ts > minuteAgo);
  if (recentHits.length >= 15) {
    burstLimitMap.set(burstKey, recentHits);
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }
  recentHits.push(now);
  burstLimitMap.set(burstKey, recentHits);
    
  // 3. Daily limiter
  const key = `${clientKey}_${today}`;
  const count = rateLimitMap.get(key) || 0;
  
  // 3. Daily limiter per IP (same quota as the browser `amDailyLimit` check)
  if (count >= DAILY_QUESTION_LIMIT) {
    return res.status(429).json({ error: 'DAILY_LIMIT' });
  }

  // 4. Validate client input and compose prompt on server.
  const body = req.body || {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const lang = body.lang === 'gu' ? 'gu' : 'en';
  const legacyMessage = typeof body.message === 'string' ? body.message.trim() : '';

  if (!question && !legacyMessage) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  if (question && question.length > MAX_QUESTION_CHARS) {
    return res.status(413).json({
      error: 'QUESTION_TOO_LONG',
      max_question_chars: MAX_QUESTION_CHARS
    });
  }

  const safeMessage = question
    ? `${SYSTEM_PROMPT}\n\n${LANG_SUFFIXES[lang]}\n\n[USER QUESTION]\n${question}`
    : legacyMessage;

  // 5. Upstream timeout: Gujarati generation is slower (Unicode, stricter prompt)
  // and needs more wall-clock time than English. Keep under api/ask.js maxDuration in vercel.json.
  const upstreamTimeoutMs = lang === 'gu' ? 55000 : 25000;
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    const response = await fetch('https://api.straico.com/v1/prompt/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.STRAICO_KEY
      },
      body: JSON.stringify({
        models: ['deepseek/deepseek-chat-v3-0324'],
        message: safeMessage,
        // Gujarati uses more tokens per word than English; 700 often truncates before the closing line.
        max_tokens: 800
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.message || 'Upstream error',
        upstream_status: response.status
      });
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