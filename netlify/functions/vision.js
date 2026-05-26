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
    const isPDF = mediaType === 'application/pdf';

    const systemPrompt = 'You are Concierge — a brilliant advisor who just read this ' + (isPDF ? 'document' : 'image') + ' for someone dealing with a ' + category + ' issue.\n\nExtract and explain:\n1. What exactly is this? (document type, sender, purpose)\n2. The most critical number, date, or deadline\n3. What it means in plain English\n4. The ONE thing they must do first and by when\n\nBe like a brilliant lawyer friend who reads their scary mail and says "OK here is what this actually means and here is what you do." Specific. Direct. No legal jargon. 3-4 sentences max.';

    const userMessage = context
      ? 'Situation so far: ' + context + '\n\nNow analyzing this ' + (isPDF ? 'document' : 'image') + ' — what are the key facts and what should they do?'
      : 'What are the key facts in this ' + (isPDF ? 'document' : 'image') + ' and what does the person need to know or do?';

    // Build content array based on file type
    const contentArray = [];

    if (isPDF) {
      contentArray.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: image
        }
      });
    } else {
      contentArray.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType || 'image/jpeg',
          data: image
        }
      });
    }

    contentArray.push({ type: 'text', text: userMessage });

    const payload = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentArray }]
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
          'anthropic-beta': 'pdfs-2024-09-25',
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
    if (result.status !== 200) throw new Error(data.error ? data.error.message : 'Vision API error ' + result.status);

    const description = data.content[0].text;
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, isPDF })
    };

  } catch (err) {
    console.error('Vision error:', err.message);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
