const https = require('https');

// Current valid ElevenLabs voice IDs (verified 2025)
const VOICES = {
  rachel: '21m00Tcm4TlvDq8ikWAM', // Rachel
  adam:   'pNInz6obpgDQGcFmaJgB', // Adam
  bella:  'EXAVITQu4vr4xnSDxMaL', // Bella
  josh:   'TxGEqnHWrfWFTfGW9XjX', // Josh
};

function makeRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.request(options, (res) => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('No ELEVENLABS_API_KEY env var');
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key configured' }) };
  }

  // GET = test endpoint
  if (event.httpMethod === 'GET') {
    const path = event.path || '';
    if (path.includes('voices')) {
      // List available voices
      const test = await makeRequest({
        hostname: 'api.elevenlabs.io',
        path: '/v1/voices',
        method: 'GET',
        headers: { 'xi-api-key': apiKey }
      });
      const data = JSON.parse(test.body.toString());
      const voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category }));
      return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(voices) };
    }
    // Default — test user
    const test = await makeRequest({
      hostname: 'api.elevenlabs.io',
      path: '/v1/user',
      method: 'GET',
      headers: { 'xi-api-key': apiKey }
    });
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: test.status, body: test.body.toString() }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { text, voice = 'sarah' } = JSON.parse(event.body);
    const voiceId = VOICES[voice] || VOICES.sarah;

    const clean = text.replace(/[*_#`]/g, '').replace(/\n+/g, ' ').trim().substring(0, 500);
    console.log(`Speaking with voice ${voice} (${voiceId}): "${clean.substring(0, 50)}..."`);

    const payload = Buffer.from(JSON.stringify({
      text: clean,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    }));

    const result = await makeRequest({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
        'Content-Length': payload.length
      }
    }, payload);

    console.log('ElevenLabs response status:', result.status);

    if (result.status !== 200) {
      const errText = result.body.toString();
      console.error('ElevenLabs error body:', errText);
      throw new Error(`ElevenLabs ${result.status}: ${errText}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg', ...corsHeaders, 'Cache-Control': 'no-cache' },
      body: result.body.toString('base64'),
      isBase64Encoded: true
    };

  } catch (err) {
    console.error('Speak function error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: err.message })
    };
  }
};
