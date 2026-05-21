const https = require('https');

const VOICES = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  adam:   'pNInz6obpgDQGcFmaJgB',
  bella:  'EXAVITQu4vr4xnSDxMaL',
  josh:   'TxGEqnHWrfWFTfGW9XjX',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { text, voice = 'rachel' } = JSON.parse(event.body);
    const voiceId = VOICES[voice] || VOICES.rachel;

    const clean = text
      .replace(/[*_#`]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .substring(0, 500);

    const payload = JSON.stringify({
      text: clean,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    });

    const audioData = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Accept': 'audio/mpeg',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        console.log('ElevenLabs status:', res.statusCode);
        if (res.statusCode !== 200) {
          let err = '';
          res.on('data', c => err += c);
          res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${err}`)));
          return;
        }
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: audioData.toString('base64'),
      isBase64Encoded: true
    };

  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
