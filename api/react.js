const rateLimitMap = new Map();
let lastClearedDate = new Date().toDateString();

const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'https://www.ask-maharaj.vercel.app'
]);

const VALID_REACTIONS = ['jai', 'nischay', 'sparsh', 'dharan'];

const BIKA_API_TOKEN = process.env.BIKA_API_TOKEN || 'bktuaZzDjU3ukrVPFXQsSCjhioYnYiuabwr';
const BIKA_SPACE_ID  = process.env.BIKA_SPACE_ID  || 'spc6FAjCrHVa6VHNbXte8viT';
const BIKA_NODE_ID   = process.env.BIKA_NODE_ID   || 'datbO2aMFaOn3xmtiTAAEnPj';

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
    if (requestHost && originUrl.host === requestHost) return true;
    return getAllowedOrigins().has(origin);
  } catch {
    return false;
  }
}

function getBikaRecordUrl(recordId) {
  return `https://bika.ai/api/openapi/bika/v1/spaces/${BIKA_SPACE_ID}/resources/databases/${BIKA_NODE_ID}/records/${encodeURIComponent(recordId)}`;
}

function getBikaBaseUrl() {
  return `https://bika.ai/api/openapi/bika/v1/spaces/${BIKA_SPACE_ID}/resources/databases/${BIKA_NODE_ID}/records`;
}

function parseUserAgent(ua) {
  const str = ua || '';
  let browser = 'Other';
  if (str.includes('Edg/'))          browser = 'Edge';
  else if (str.includes('Chrome/'))  browser = 'Chrome';
  else if (str.includes('Firefox/')) browser = 'Firefox';
  else if (str.includes('Safari/') && !str.includes('Chrome')) browser = 'Safari';

  let os = 'Other';
  if (str.includes('Android'))       os = 'Android';
  else if (str.includes('iPhone') || str.includes('iPad')) os = 'iOS';
  else if (str.includes('Windows'))  os = 'Windows';
  else if (str.includes('Mac'))      os = 'Mac';
  else if (str.includes('Linux'))    os = 'Linux';

  let device = 'Desktop';
  if (str.includes('Mobile') || str.includes('Android') || str.includes('iPhone')) device = 'Mobile';
  else if (str.includes('iPad') || str.includes('Tablet')) device = 'Tablet';

  return { browser, os, device };
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

  if (origin) {
    if (!isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
    }
  } else if (!sameOriginFetch) {
    return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  }
  if (origin) setCorsHeaders(res, origin);

  if (!BIKA_API_TOKEN || !BIKA_SPACE_ID || !BIKA_NODE_ID) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED: Missing BIKA env' });
  }

  // Daily map clear at midnight
  const today = new Date().toDateString();
  if (today !== lastClearedDate) {
    rateLimitMap.clear();
    lastClearedDate = today;
  }

  const ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const body = req.body || {};
  const action     = typeof body.action     === 'string' ? body.action.trim()     : '';
  const recordId   = typeof body.recordId   === 'string' ? body.recordId.trim()   : '';
  const reactionId = typeof body.reaction_id === 'string' ? body.reaction_id.trim() : '';

  // ── ACTION: log (called from api/ask.js after successful answer) ──
  if (action === 'log') {
    const question       = typeof body.question === 'string' ? body.question.slice(0, 4000) : '';
    const answer         = typeof body.answer   === 'string' ? body.answer.slice(0, 8000)   : '';
    const coins          = typeof body.coins    === 'number' ? body.coins    : 0;
    const lang           = body.lang === 'gu' ? 'gu' : 'en';
    const cacheHit       = body.cacheHit === true;
    const responseMs     = typeof body.responseMs === 'number' ? body.responseMs : 0;
    const questionLength = question.length;
    const location       = typeof body.location === 'string' ? body.location.slice(0, 100) : '';
    const ua             = req.headers['user-agent'] || '';
    const { browser, os, device } = parseUserAgent(ua);

    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(getBikaBaseUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BIKA_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cells: {
            Question:       question,
            Answer:         answer,
            Coins:          coins,
            IP:             ip,
            Location:       location,
            Device:         device,
            OS:             os,
            Browser:        browser,
            Language:       lang,
            Reaction:       '',
            CacheHit:       cacheHit,
            ResponseMs:     responseMs,
            QuestionLength: questionLength,
            Status:         'answered'
          }
        }),
        signal: controller.signal
      });

      if (!resp.ok) {
        // Don't fail the user — just silently return
        return res.status(200).json({ ok: false, error: 'BIKA_LOG_FAILED' });
      }

      const data = await resp.json().catch(() => ({}));
      // Return the Bika record ID to frontend so reactions can reference it
      const bikaRecordId = data?.id || data?.record?.id || data?.data?.id || null;
      return res.status(200).json({ ok: true, recordId: bikaRecordId });

    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(200).json({ ok: false, error: 'BIKA_TIMEOUT' });
      }
      return res.status(200).json({ ok: false, error: 'SERVER_ERROR' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // ── ACTION: react (called from frontend when user taps a reaction) ──
  if (action === 'react') {
    // Rate limit — max 20 reaction updates per day per IP
    const key = `${ip}_${today}`;
    const count = rateLimitMap.get(key) || 0;
    if (count >= 20) {
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    rateLimitMap.set(key, count + 1);

    if (!recordId || !reactionId) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }

    // Validate recordId format
    if (!/^[a-zA-Z0-9]{10,30}$/.test(recordId)) {
      return res.status(400).json({ error: 'INVALID_RECORD_ID' });
    }

    // Validate reaction against allowlist
    if (!VALID_REACTIONS.includes(reactionId)) {
      return res.status(400).json({ error: 'INVALID_REACTION' });
    }

    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(getBikaRecordUrl(recordId), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${BIKA_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cells: { Reaction: reactionId }
        }),
        signal: controller.signal
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        return res.status(resp.status).json({
          error: 'BIKA_UPDATE_FAILED',
          details: err?.message || err?.error || null
        });
      }

      const data = await resp.json().catch(() => ({}));
      return res.status(200).json({ ok: true, data });

    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'BIKA_TIMEOUT' });
      }
      return res.status(500).json({ error: 'SERVER_ERROR' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // Unknown action
  return res.status(400).json({ error: 'INVALID_ACTION' });
}