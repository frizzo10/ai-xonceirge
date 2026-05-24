const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

async function sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'erlfsyarkcsthrwrdenz.supabase.co',
      path: `/rest/v1/${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getOrCreateUser(deviceId) {
  const find = await sbRequest('GET', `users?device_id=eq.${encodeURIComponent(deviceId)}&select=id`);
  const users = JSON.parse(find.body);
  if (users && users.length > 0) return users[0].id;
  const create = await sbRequest('POST', 'users', { device_id: deviceId });
  const created = JSON.parse(create.body);
  return Array.isArray(created) ? created[0].id : created.id;
}

async function createCase(deviceId, category, title) {
  const res = await sbRequest('POST', 'cases', {
    user_id: deviceId, category, title, status: 'active', context: [], timeline: []
  });
  const data = JSON.parse(res.body);
  return Array.isArray(data) ? data[0] : data;
}

async function updateCase(caseId, updates) {
  await sbRequest('PATCH', `cases?id=eq.${caseId}`, {
    ...updates, updated_at: new Date().toISOString()
  });
}

async function getCase(caseId) {
  const res = await sbRequest('GET', `cases?id=eq.${caseId}&select=*`);
  const data = JSON.parse(res.body);
  return Array.isArray(data) ? data[0] : null;
}

async function scheduleFollowup(caseId, userId, message, daysFromNow) {
  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + daysFromNow);
  await sbRequest('POST', 'followups', {
    case_id: caseId, user_id: userId, message,
    scheduled_for: scheduledFor.toISOString(), sent: false
  });
}

async function callGroq(messages, systemPrompt) {
  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 400,
    temperature: 0.65,
    messages: [{ role: 'system', content: systemPrompt }, ...messages]
  });
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  const data = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(data.error?.message || 'Groq error');
  return data.choices[0].message.content;
}

async function generateTimeline(category, messages) {
  const prompt = `Based on this ${category} situation: ${JSON.stringify(messages.slice(-4))}
Generate a follow-up timeline as JSON array, max 4 items: [{day, action, followup_message}]
Return ONLY valid JSON, no markdown.`;
  try {
    const r = await callGroq([{ role: 'user', content: prompt }], 'Return only valid JSON arrays.');
    return JSON.parse(r.replace(/```json|```/g, '').trim());
  } catch(e) { return []; }
}

const SYSTEM = `You are Concierge — a brilliant problem-solver who already knows this user.

WHAT YOU KNOW is in your system prompt. Use it. Never ask for info already provided.
- Know their car? Never ask for make/model/year.
- Know their location? Never ask for city/zip.
- Know their name? Use ONLY that exact name. Never invent or guess a name.

RULES:
1. ONE question per response. Never two.
2. 2 sentences max. Direct. Like a text message.
3. NEVER invent names, facts, or details not provided.
4. Always move toward solving.
5. Never assume symptoms — wait for them to describe it.

FOR LOCAL BUSINESSES: Only add [PLACES_SEARCH: query near city] when the user asks to find someone or somewhere. Not automatically.

NEVER fake bookings or invent business names. NEVER QUIT until solved.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { messages, category, deviceId, caseId, profile } = JSON.parse(event.body);
    let activeCaseId = caseId;

    if (deviceId) {
      try {
        if (!activeCaseId && category && messages.length > 0) {
          // Check for existing open case in this category — reuse it
          const existing = await sbRequest('GET', 
            `cases?user_id=eq.${encodeURIComponent(deviceId)}&category=eq.${category}&status=eq.active&order=updated_at.desc&limit=1`
          );
          const existingCases = JSON.parse(existing.body);
          if (existingCases && existingCases.length > 0) {
            activeCaseId = existingCases[0].id;
            // Append new messages to existing context
            const existingContext = Array.isArray(existingCases[0].context) ? existingCases[0].context : [];
            // Merge — keep existing history + new messages
            const merged = [...existingContext, ...messages.filter(m => 
              !existingContext.some(e => e.role === m.role && e.content === m.content)
            )];
            await updateCase(activeCaseId, { context: merged });
          } else {
            // Create new case — first time for this category
            const title = `${category}`;
            const newCase = await createCase(deviceId, category, title);
            activeCaseId = newCase?.id;
          }
        } else if (activeCaseId) {
          await updateCase(activeCaseId, { context: messages });
        }
        // (case update handled above)
        if (activeCaseId && messages.length >= 6 && messages.length % 4 === 2) {
          const existing = await getCase(activeCaseId);
          if (existing && (!existing.timeline || existing.timeline.length === 0)) {
            const timeline = await generateTimeline(category, messages);
            if (timeline.length > 0) {
              await updateCase(activeCaseId, { timeline });
              for (const item of timeline) {
                await scheduleFollowup(activeCaseId, deviceId, item.followup_message, item.day);
              }
            }
          }
        }
      } catch(dbErr) {
        console.error('DB error:', dbErr.message);
      }
    }

    // Load profile context
    let profileContext = '';
    if (deviceId) {
      try {
        const pr = await sbRequest('GET', `users?device_id=eq.${encodeURIComponent(deviceId)}&select=profile`);
        const pd = JSON.parse(pr.body);
        const profile = pd?.[0]?.profile;
        if (profile && Object.keys(profile).length > 0) {
          profileContext = '\n\nKNOWN ABOUT THIS USER (do not ask again): ' + JSON.stringify(profile);
        }
      } catch(e) {}
    }

    // Extract any system context messages and merge into prompt
    const systemMsgs = messages.filter(m => m.role === 'system').map(m => m.content).join(' ');
    const chatMsgs = messages.filter(m => m.role !== 'system').slice(-8);
    const fullSystem = SYSTEM + profileContext + (systemMsgs ? '\n\n' + systemMsgs : '');
    console.log('SYSTEM PROMPT:', fullSystem.substring(0, 300));
    console.log('MESSAGES:', JSON.stringify(chatMsgs));
    const reply = await callGroq(chatMsgs, fullSystem);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ reply, caseId: activeCaseId })
    };

  } catch (err) {
    console.error('Handler error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
