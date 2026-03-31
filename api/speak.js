import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TTS_BUCKET = process.env.TTS_CACHE_BUCKET || 'tts-cache';
const MONTHLY_CHAR_LIMIT = 900000;
const MAX_TTS_CHARS = 4500;

async function ensureTtsBucket() {
  const { data: list, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) return { ok: false, error: listErr.message || 'Failed to list buckets' };
  const exists = Array.isArray(list) && list.some(b => b && b.name === TTS_BUCKET);
  if (exists) return { ok: true };

  const { error: createErr } = await supabase.storage.createBucket(TTS_BUCKET, {
    public: true,
    allowedMimeTypes: ['audio/mpeg']
  });
  if (createErr) return { ok: false, error: createErr.message || 'Failed to create bucket' };
  return { ok: true };
}

function getMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function stripHtml(input) {
  return String(input || '').replace(/<[^>]*>/g, '').trim();
}

function getVoiceConfig(lang) {
  if (lang === 'gu') {
    return {
      languageCode: 'gu-IN',
      name: 'gu-IN-Wavenet-B'
    };
  }
  return {
    languageCode: 'en-GB',
    name: 'en-GB-Wavenet-D'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});
    const textRaw = body?.text;
    const lang = body?.lang === 'gu' ? 'gu' : 'en';
    const strippedText = stripHtml(textRaw);

    if (!strippedText) {
      return res.status(400).json({ error: 'Text is required' });
    }
    if (strippedText.length > MAX_TTS_CHARS) {
      return res.status(413).json({ error: `TEXT_TOO_LONG: max ${MAX_TTS_CHARS} chars` });
    }

    if (!process.env.GOOGLE_TTS_API_KEY) {
      return res.status(500).json({ error: 'Missing GOOGLE_TTS_API_KEY' });
    }

    const bucketReady = await ensureTtsBucket();
    if (!bucketReady.ok) {
      return res.status(500).json({ error: bucketReady.error || 'TTS bucket unavailable' });
    }

    const cacheKey = crypto.createHash('md5').update(strippedText).digest('hex');
    const fileName = `${cacheKey}.mp3`;

    // Step 1: Supabase Storage cache check
    const { data: cachedAudio, error: cacheReadError } = await supabase.storage
      .from(TTS_BUCKET)
      .download(fileName);
    if (cachedAudio && !cacheReadError) {
      const { data: publicData } = supabase.storage.from(TTS_BUCKET).getPublicUrl(fileName);
      if (publicData?.publicUrl) {
        return res.status(200).json({ audioUrl: publicData.publicUrl });
      }
    }

    // Step 2: Monthly quota check
    const month = getMonthKey();
    const { data: usageRow, error: usageReadError } = await supabase
      .from('tts_usage')
      .select('chars_used')
      .eq('month', month)
      .maybeSingle();
    if (usageReadError) {
      return res.status(500).json({ error: usageReadError.message || 'Failed to read usage' });
    }

    const charsUsed = Number(usageRow?.chars_used || 0);
    const newChars = strippedText.length;
    if (charsUsed + newChars > MONTHLY_CHAR_LIMIT) {
      return res.status(429).json({ error: 'QUOTA_EXCEEDED' });
    }

    // Step 3: Google Cloud TTS synth
    const voice = getVoiceConfig(lang);
    let ttsResp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: strippedText },
          voice: {
            languageCode: voice.languageCode,
            name: voice.name
          },
          audioConfig: { audioEncoding: 'MP3' }
        })
      }
    );

    // Fallback: if a named voice is unavailable in this project/region, retry with languageCode only.
    if (!ttsResp.ok) {
      ttsResp = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text: strippedText },
            voice: { languageCode: voice.languageCode },
            audioConfig: { audioEncoding: 'MP3' }
          })
        }
      );
    }

    if (!ttsResp.ok) {
      const ttsErr = await ttsResp.json().catch(() => ({}));
      return res.status(ttsResp.status).json({
        error: ttsErr?.error?.message || 'Google TTS request failed'
      });
    }

    const ttsData = await ttsResp.json();
    const audioContent = ttsData?.audioContent;
    if (!audioContent) {
      return res.status(502).json({ error: 'No audioContent from Google TTS' });
    }

    const audioBuffer = Buffer.from(audioContent, 'base64');
    const { error: uploadError } = await supabase.storage.from(TTS_BUCKET).upload(fileName, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert: true
    });
    if (uploadError) {
      return res.status(500).json({ error: uploadError.message || 'Failed to upload audio' });
    }

    const { data: uploadedPublic } = supabase.storage.from(TTS_BUCKET).getPublicUrl(fileName);
    const audioUrl = uploadedPublic?.publicUrl;
    if (!audioUrl) {
      return res.status(500).json({ error: 'Failed to resolve public URL' });
    }

    // Step 4: Usage upsert/increment
    const { error: usageWriteError } = await supabase.from('tts_usage').upsert(
      {
        month,
        chars_used: charsUsed + newChars
      },
      { onConflict: 'month' }
    );
    if (usageWriteError) {
      return res.status(500).json({ error: usageWriteError.message || 'Failed to update usage' });
    }

    // Step 5: Final response
    return res.status(200).json({ audioUrl });
  } catch (err) {
    const message = err && err.message ? err.message : 'Server error';
    return res.status(500).json({ error: message });
  }
}
