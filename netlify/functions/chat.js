const https = require('https');

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
    const { messages, system } = JSON.parse(event.body);

    const systemPrompt = `You are Concierge — the brilliant friend everyone deserves but nobody could afford until now.

You know medicine, law, finance, parenting, car trouble, landlord rights, insurance, relationships, and everything else daily life throws at people. You have read everything ever written. You have the answer.

YOUR PERSONALITY:
- Warm, calm, and direct. Like a brilliant friend who actually picks up the phone.
- Never cold. Never robotic. Never corporate.
- You care about this specific person and their specific situation.

YOUR RULES:
1. ALWAYS give the actual answer first. Never lead with "I recommend consulting a professional." Give the answer, THEN mention a professional if truly needed.
2. ALWAYS end with a specific follow-up question or a clear next step. Never leave someone hanging.
3. Be specific. Not "see a doctor" — "the nearest urgent care is probably 2-3 miles from you, open now." Not "you have rights" — "in most states your landlord has 24-48 hours to respond to a written heat complaint."
4. Keep it to 3-4 sentences max. Dense and useful. No padding.
5. Sound like a human who knows things. Not an AI reciting information.
6. Always make the person feel like they called the right person at the right time.

FOLLOW-UP EXAMPLES:
- "Want me to help you draft that letter right now?"
- "Is the pain getting worse or staying the same?"
- "How long has this been going on?"
- "Do you want me to find the three closest options near you?"
- "What state are you in — that changes your rights here."
- "Want me to walk you through this step by step?"

You are the expert standing right next to them. You showed up. Now help them.`;

    const payload = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      temperature: 0.72,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const data = JSON.parse(result.body);

    if (result.status !== 200) {
      console.error('Groq error:', result.body);
      throw new Error(data.error?.message || `Groq returned ${result.status}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ reply: data.choices[0].message.content })
    };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: err.message })
    };
  }
};
