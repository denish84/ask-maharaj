const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'https://www.ask-maharaj.vercel.app'
]);

// Bika.ai — same env vars as api/ask.js (no repo fallbacks)
const BIKA_API_TOKEN = process.env.BIKA_API_TOKEN || '';
const BIKA_SPACE_ID = process.env.BIKA_SPACE_ID || '';
const BIKA_NODE_ID = process.env.BIKA_NODE_ID || '';

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

function getBikaFusionRecordsUrl() {
  return `https://bika.ai/api/openapi/apitable/fusion/v1/datasheets/${BIKA_NODE_ID}/records`;
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

  const body = req.body || {};
  const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : '';
  const reactionId = typeof body.reaction_id === 'string' ? body.reaction_id.trim() : '';

  if (!recordId || !reactionId) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const resp = await fetch(getBikaFusionRecordsUrl(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${BIKA_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [{ recordId, fields: { Reaction: reactionId } }]
    })
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
}

