const https = require('https');

const VOICES = {
  sarah:   'EXAVITQu4vr4xnSDxMaL',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  jessica: 'cgSgspJ2msm6clMCkdW9',
  eric:    'cjVigY5qzO86Huf0OWal',
  george:  'JBFqnCBsd6RMkjVDRZzb',
  brian:   'nPczCjzI2devNBz1zQrb',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  // GET voices list
  if (event.httpMethod === 'GET') {
    const data = await new Promise((resolve, reject) => {
      https.get({ hostname: 'api.elevenlabs.io', path: '/v1/voices', headers: { 'xi-api-key': apiKey } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }).on('error', reject);
    });
    const voices = JSON.parse(data.body).voices?.map(v => ({ id: v.voice_id, name: v.name, category: v.category })) || [];
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(voices) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { text, voice = 'sarah' } = JSON.parse(event.body);
    const voiceId = VOICES[voice] || VOICES.sarah;
    const clean = text.replace(/[*_#`]/g, '').replace(/\n+/g, ' ').trim().substring(0, 500);

    console.log(`ElevenLabs: voice=${voice} id=${voiceId} text="${clean.substring(0,40)}"`);

    const bodyStr = JSON.stringify({
      text: clean,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });

    const audio = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          'Accept': 'audio/mpeg',
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      }, res => {
        console.log('ElevenLabs HTTP status:', res.statusCode);
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(buf);
          else reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString()}`));
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg', ...CORS, 'Cache-Control': 'no-cache' },
      body: audio.toString('base64'),
      isBase64Encoded: true
    };

  } catch (err) {
    console.error('Speak error:', err.message);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
