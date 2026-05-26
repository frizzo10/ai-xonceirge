const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  try {
    const { image, mediaType, category, context } = JSON.parse(event.body);

    const systemPrompt = `You are Concierge — a brilliant problem-solver analyzing an image for a user who needs help.
Category: ${category}
Be specific and actionable. Describe exactly what you see that's relevant to their situation.
1-3 sentences. Direct. Like a smart friend looking at their photo.
Focus on what matters for solving their problem.`;

    const userMessage = context 
      ? `Here's the situation so far: ${context}\n\nNow I'm looking at this image — what do you see that's relevant?`
      : 'What do you see in this image that can help me?';

    const payload = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/jpeg',
              data: image
            }
          },
          { type: 'text', text: userMessage }
        ]
      }]
    });

    const result = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const data = JSON.parse(result.body);
    if (result.status !== 200) throw new Error(data.error ? data.error.message : 'Vision API error');

    const description = data.content[0].text;
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    };

  } catch (err) {
    console.error('Vision error:', err.message);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
