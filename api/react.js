const ALLOWED_ORIGINS = new Set([
  'https://ask-maharaj.vercel.app',
  'https://www.ask-maharaj.vercel.app'
]);

// Bika.ai (temporary inline defaults; move to .env later)
const BIKA_API_TOKEN =
  process.env.BIKA_API_TOKEN ||
  'bktuaZzDjU3ukrVPFXQsSCjhioYnYiuabwr';
const BIKA_SPACE_ID =
  process.env.BIKA_SPACE_ID ||
  'spc6FAjCrHVa6VHNbXte8viT';
const BIKA_NODE_ID =
  process.env.BIKA_NODE_ID ||
  'datbO2aMFaOn3xmtiTAAEnPj';

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
  const base = `https://bika.ai/api/openapi/bika/v1/spaces/${BIKA_SPACE_ID}/resources/databases/${BIKA_NODE_ID}/records`;
  return `${base}/${encodeURIComponent(recordId)}`;
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

  // #region agent log
  fetch('http://127.0.0.1:7802/ingest/7c7dbc96-7639-402c-ac7a-995396caba49',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cee8ba'},body:JSON.stringify({sessionId:'cee8ba',runId:'pre-fix',hypothesisId:'H2',location:'api/react.js:handler',message:'Bika PATCH start',data:{recordIdPresent:!!recordId,reactionId,patchUrl:getBikaRecordUrl(recordId)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  const resp = await fetch(getBikaRecordUrl(recordId), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${BIKA_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      cells: {
        Reaction: reactionId
      }
    })
  });

  const data = await resp.json().catch(() => ({}));

  // Per user request: surface response for debugging (avoid secrets/PII)
  console.log('Bika Response:', JSON.stringify(data));

  // #region agent log
  fetch('http://127.0.0.1:7802/ingest/7c7dbc96-7639-402c-ac7a-995396caba49',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cee8ba'},body:JSON.stringify({sessionId:'cee8ba',runId:'pre-fix',hypothesisId:'H2',location:'api/react.js:handler',message:'Bika PATCH done',data:{ok:resp.ok,status:resp.status,topLevelKeys:data&&typeof data==='object'?Object.keys(data).slice(0,12):null,dataId:data?.id??null,dataDataId:data?.data?.id??null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (!resp.ok) {
    const err = data || {};
    return res.status(resp.status).json({
      error: 'BIKA_UPDATE_FAILED',
      details: err?.message || err?.error || null
    });
  }

  return res.status(200).json({ ok: true, data });
}

