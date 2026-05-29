const https = require('https');

const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

async function sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'erlfsyarkcsthrwrdenz.supabase.co',
      path: '/rest/v1/' + path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
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
  const find = await sbRequest('GET', 'users?device_id=eq.' + encodeURIComponent(deviceId) + '&select=id');
  const users = JSON.parse(find.body);
  if (users && users.length > 0) return users[0].id;
  const create = await sbRequest('POST', 'users', { device_id: deviceId });
  const created = JSON.parse(create.body);
  return Array.isArray(created) ? created[0].id : created.id;
}

async function updateCase(caseId, updates) {
  await sbRequest('PATCH', 'cases?id=eq.' + caseId, {
    ...updates, updated_at: new Date().toISOString()
  });
}

async function getCase(caseId) {
  const res = await sbRequest('GET', 'cases?id=eq.' + caseId + '&select=*');
  const data = JSON.parse(res.body);
  return Array.isArray(data) ? data[0] : null;
}

async function scheduleFollowup(caseId, deviceId, message, daysFromNow) {
  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + daysFromNow);
  await sbRequest('POST', 'followups', {
    case_id: caseId, user_id: deviceId, message,
    scheduled_for: scheduledFor.toISOString(), sent: false
  });
}

async function callGroq(messages, systemPrompt) {
  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 180,
    temperature: 0.5,
    messages: [{ role: 'system', content: systemPrompt }, ...messages]
  });
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY,
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
  if (result.status !== 200) throw new Error(data.error ? data.error.message : 'Groq error');
  return data.choices[0].message.content;
}

async function generateTimeline(category, messages) {
  const prompt = 'Based on this ' + category + ' situation generate a follow-up timeline as JSON array max 4 items: [{day, action, followup_message}]. Return ONLY valid JSON.\n\n' + JSON.stringify(messages.slice(-4));
  try {
    const r = await callGroq([{ role: 'user', content: prompt }], 'Return only valid JSON arrays. No markdown.');
    return JSON.parse(r.replace(/```json|```/g, '').trim());
  } catch(e) { return []; }
}

const SYSTEM = 'You are Concierge. A brilliant problem-solver who finishes what they start.\n\nPROFILE: Everything you know about the user is in your system prompt. Use it. Never ask for it.\n\nHOW TO TALK:\n- Acknowledge first. "Got it." "Makes sense." Then ask or answer.\n- Sound human. Like a smart friend who knows everything.\n- 1-2 sentences max. Direct.\n\nFINISH THE JOB — THIS IS YOUR PRIME DIRECTIVE:\nEvery conversation must reach its finish line. Do not stop in the middle. Do not trail off. Drive all the way to done.\nFINISH LINES:\n- car: symptom understood + diagnosis given + [PLACES_SEARCH: auto repair near city] + human confirms shop\n- medical: urgency assessed + next step clear + [PLACES_SEARCH: urgent care/doctor near city] if needed\n- legal/landlord: rights explained + letter drafted or next step given\n- bills/insurance: script given or claim strategy clear\n- home: fix explained + [PLACES_SEARCH: plumber/electrician near city] if needed\n\nWhen you have enough info — GIVE THE ANSWER. Stop gathering. Start solving.\nWhen diagnosis is done — find local help: [PLACES_SEARCH: query near city]\nNever stop at diagnosis. Always take it to the next physical step.\n\nVISUAL EVIDENCE:\nThe user can share photos and documents via the attachment button. When they share one, you receive a description starting with [Photo shared]. ACTIVELY REASON about what you need: what document, photo, or detail would change your diagnosis? Ask for it specifically. SYNTHESIZE EVERYTHING: connect all photos, docs, and conversation into one complete picture.\n\nWHEN TO ADD [RESOLVED]: Never decide this yourself. Only add [RESOLVED] after the human explicitly confirms with words like yes, perfect, that works, got it, thanks. You propose — they approve — then [RESOLVED].\n\nSTAY ON TOPIC: If input is unclear - "Didn\'t catch that — [restate question]."\n\nNEVER fake bookings. NEVER invent names. NEVER repeat their car/name more than once.';

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
          // Check for existing open case in this category
          const existing = await sbRequest('GET',
            'cases?user_id=eq.' + encodeURIComponent(deviceId) + '&category=eq.' + category + '&status=eq.active&order=updated_at.desc&limit=1'
          );
          const existingCases = JSON.parse(existing.body);
          if (existingCases && existingCases.length > 0) {
            activeCaseId = existingCases[0].id;
          } else {
            const title = category + ' — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const newCase = await sbRequest('POST', 'cases', {
              user_id: deviceId, category, title, status: 'active', context: [], timeline: []
            });
            const nc = JSON.parse(newCase.body);
            activeCaseId = Array.isArray(nc) ? nc[0].id : nc.id;
          }
        }
        if (activeCaseId) {
          await updateCase(activeCaseId, { context: messages });
        }
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

    // Profile context — only inject relevant fields per category
    let profileContext = '';
    if (profile) {
      const carCategories = ['car'];
      const medCategories = ['medical', 'anxiety', 'sleep'];
      const kidsCategories = ['kids', 'school'];
      
      let relevantProfile = profile;
      
      // For car — exclude health notes (not relevant)
      if (carCategories.includes(category)) {
        relevantProfile = profile.split('. ').filter(p => 
          !p.toLowerCase().startsWith('health')
        ).join('. ');
      }
      // For medical — exclude car info
      if (medCategories.includes(category)) {
        relevantProfile = profile.split('. ').filter(p => 
          !p.toLowerCase().startsWith('vehicles') && !p.toLowerCase().startsWith('car')
        ).join('. ');
      }
      // For kids/school — exclude car and health
      if (kidsCategories.includes(category)) {
        relevantProfile = profile.split('. ').filter(p => 
          !p.toLowerCase().startsWith('vehicles') && !p.toLowerCase().startsWith('health')
        ).join('. ');
      }
      
      profileContext = '\n\nWHAT YOU KNOW ABOUT THIS USER — never ask for any of this, and only mention what is directly relevant:\n' + relevantProfile;
    }

    const systemMsgs = messages.filter(m => m.role === 'system').map(m => m.content).join(' ');
    const chatMsgs = messages.filter(m => m.role !== 'system').slice(-16);
    const fullSystem = SYSTEM + profileContext + (systemMsgs ? '\n\n' + systemMsgs : '');

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
