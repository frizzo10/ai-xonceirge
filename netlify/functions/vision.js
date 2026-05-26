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

    const systemPrompt = 'You are Concierge — a brilliant advisor analyzing a document or image for someone who needs help with a ' + category + ' situation.\n\nBe specific and direct. Extract the most important facts:\n- What is this document/image?\n- What are the key numbers, dates, deadlines?\n- What does this mean for them?\n- What is the single most important thing they need to know or do?\n\n2-3 sentences max. Like a smart lawyer friend who just read their document.';

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
