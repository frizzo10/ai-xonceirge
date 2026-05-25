const https = require('https');

const VOICES = {
  sarah:   'Sarah',
  michael: 'Michael', 
  jessica: 'Jessica',
  george:  'George',
  aria:    'Aria',
  brian:   'Brian',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ voices: Object.keys(VOICES), ok: true }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { text, voice = 'sarah' } = JSON.parse(event.body);
    const voiceId = VOICES[voice] || VOICES.sarah;
    const clean = text.replace(/[*_#`]/g, '').replace(/\n+/g, ' ').trim().substring(0, 500);

    console.log(`Inworld TTS: voice=${voiceId} text="${clean.substring(0, 50)}"`);

    const bodyStr = JSON.stringify({
      text: clean,
      voiceId: voiceId,
      modelId: 'inworld-tts-1.5-max',
      audioConfig: {
        audioEncoding: 'MP3'
      }
    });

    const result = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = https.request({
        hostname: 'api.inworld.ai',
        path: '/tts/v1/voice',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + apiKey,
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      }, res => {
        console.log('Inworld status:', res.statusCode);
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(buf);
          else reject(new Error('Inworld ' + res.statusCode + ': ' + buf.toString()));
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    // Inworld returns JSON with base64 audioContent
    const parsed = JSON.parse(result.toString());
    const audioBuffer = Buffer.from(parsed.audioContent, 'base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg', ...CORS, 'Cache-Control': 'no-cache' },
      body: audioBuffer.toString('base64'),
      isBase64Encoded: true
    };

  } catch (err) {
    console.error('Inworld error:', err.message);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
