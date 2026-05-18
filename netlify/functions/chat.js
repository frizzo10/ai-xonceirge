const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ── SUPABASE HELPERS ──
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
  // Try to find existing user
  const find = await sbRequest('GET', `users?device_id=eq.${encodeURIComponent(deviceId)}&select=id`);
  const users = JSON.parse(find.body);
  if (users && users.length > 0) return users[0].id;

  // Create new user
  const create = await sbRequest('POST', 'users', { device_id: deviceId });
  const created = JSON.parse(create.body);
  return Array.isArray(created) ? created[0].id : created.id;
}

async function createCase(userId, category, title) {
  const res = await sbRequest('POST', 'cases', {
    user_id: userId,
    category,
    title,
    status: 'active',
    context: [],
    timeline: []
  });
  const data = JSON.parse(res.body);
  return Array.isArray(data) ? data[0] : data;
}

async function updateCase(caseId, updates) {
  await sbRequest('PATCH', `cases?id=eq.${caseId}`, {
    ...updates,
    updated_at: new Date().toISOString()
  });
}

async function getCase(caseId) {
  const res = await sbRequest('GET', `cases?id=eq.${caseId}&select=*`);
  const data = JSON.parse(res.body);
  return Array.isArray(data) ? data[0] : null;
}

async function getUserCases(userId) {
  const res = await sbRequest('GET', `cases?user_id=eq.${userId}&status=eq.active&order=updated_at.desc&select=*`);
  return JSON.parse(res.body) || [];
}

async function scheduleFollowup(caseId, userId, message, daysFromNow) {
  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + daysFromNow);
  await sbRequest('POST', 'followups', {
    case_id: caseId,
    user_id: userId,
    message,
    scheduled_for: scheduledFor.toISOString(),
    sent: false
  });
}

// ── GROQ HELPER ──
async function callGroq(messages, systemPrompt) {
  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 700,
    temperature: 0.65,
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

// ── TIMELINE GENERATOR ──
async function generateTimeline(category, context) {
  const prompt = `Based on this ${category} situation: ${JSON.stringify(context)}

Generate a realistic follow-up timeline as a JSON array. Each item has:
- day (number of days from today)
- action (what to do or check)
- followup_message (what Concierge should say to check in)

Return ONLY valid JSON array, no other text. Maximum 5 items.
Example: [{"day":1,"action":"File insurance claim","followup_message":"Have you filed your claim yet? I can help you with what to say."}]`;

  try {
    const response = await callGroq(
      [{ role: 'user', content: prompt }],
      'You are a timeline generator. Return only valid JSON arrays.'
    );
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return [];
  }
}

// ── MAIN SYSTEM PROMPT ──
const BASE_SYSTEM = `You are Concierge — the brilliant, calm friend who shows up and stays until the problem is fully solved.

THE LAW: We never guess. Ever.
A wrong answer is worse than no answer. We ask until we know. Then we answer.

GATHER BEFORE YOU ANSWER — what you need by category:
CAR: year + make + model + what it's doing. Need ALL of these.
MEDICAL: age + how long + severity (1-10) + specific symptom. Need ALL.
LEGAL/LANDLORD: state + specific situation. Need BOTH.
BILLS: company + amount + how long + collections yet. Need ALL.
KIDS: child's age + exactly what happened. Need BOTH.
INSURANCE: type (auto/home/health) + what happened + what they've said. Need ALL.
WORK: exactly what happened — specific situation, specific person.
HOME: what they see/hear/smell + how long. Need BOTH.

ONE QUESTION AT A TIME. Never two. Never a list. One.
Ask the most critical missing piece. Wait. Then the next.

TRAUMA DETECTION:
Fragmented messages, panic, barely coherent = someone in crisis.
Do NOT ask for info yet. First say: "Hey. I'm here. Take a breath. Are you safe right now?"
Then walk them through it slowly. One gentle step at a time.

YOU NEVER QUIT:
You remember everything. Every detail stays with you.
Never make them repeat themselves. You were there from the start.
Stay until the problem is fully resolved — not just the immediate crisis.

WHEN YOU HAVE ENOUGH — give the real answer:
Specific. Actionable. Right for their exact situation.
End with one clear next step or offer to do the next thing for them.

TONE: Calm. Confident. Warm. Like a good lawyer who says
"Trust me. I'm gonna make this problem go away."
You've seen this before. You know what to do. You've got this.`;

// ── HANDLER ──
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
    const { messages, system, category, deviceId, caseId } = JSON.parse(event.body);

    // ── CASE MEMORY ──
    let activeCaseId = caseId;
    let userId = null;

    if (deviceId) {
      try {
        userId = await getOrCreateUser(deviceId);

        if (!activeCaseId && category && messages.length > 0) {
          // Create new case
          const firstMsg = messages[0]?.content || '';
          const title = `${category} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          const newCase = await createCase(userId, category, title);
          activeCaseId = newCase?.id;
        }

        if (activeCaseId) {
          // Save context to case
          await updateCase(activeCaseId, { context: messages });

          // After 4+ exchanges — generate timeline if not yet done
          if (messages.length === 8) {
            const existingCase = await getCase(activeCaseId);
            if (existingCase && (!existingCase.timeline || existingCase.timeline.length === 0)) {
              const timeline = await generateTimeline(category, messages);
              if (timeline.length > 0) {
                await updateCase(activeCaseId, { timeline });
                // Schedule follow-ups from timeline
                for (const item of timeline) {
                  if (userId && activeCaseId) {
                    await scheduleFollowup(activeCaseId, userId, item.followup_message, item.day);
                  }
                }
              }
            }
          }
        }
      } catch(dbErr) {
        console.error('DB error (non-fatal):', dbErr);
        // Continue even if DB fails — answer is more important
      }
    }

    // ── GROQ RESPONSE ──
    const systemPrompt = system || BASE_SYSTEM;
    const reply = await callGroq(messages, systemPrompt);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        reply,
        caseId: activeCaseId,
        userId
      })
    };

  } catch (err) {
    console.error('Handler error:', err);
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
