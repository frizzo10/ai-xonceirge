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
  const find = await sbRequest('GET', `users?device_id=eq.${encodeURIComponent(deviceId)}&select=id`);
  const users = JSON.parse(find.body);
  if (users && users.length > 0) return users[0].id;
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
    max_tokens: 800,
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
Return ONLY valid JSON array, no other text. Maximum 5 items.`;

  try {
    const response = await callGroq(
      [{ role: 'user', content: prompt }],
      'You are a timeline generator. Return only valid JSON arrays. No markdown.'
    );
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return [];
  }
}

// ── PROFILE EXTRACTOR ──
async function extractAndSaveProfile(userId, category, messages) {
  const prompt = `From this conversation extract any personal facts learned about the user.
Return ONLY a JSON object with these fields if mentioned (skip fields not mentioned):
{
  "car_year": "",
  "car_make": "",
  "car_model": "",
  "state": "",
  "zip_code": "",
  "has_kids": null,
  "num_kids": null,
  "kids_ages": [],
  "rents_or_owns": "",
  "insurance_provider": "",
  "insurance_types": [],
  "medications": [],
  "employer_situation": "",
  "landlord_name": "",
  "financial_situation": ""
}
Conversation: ${JSON.stringify(messages)}
Return ONLY valid JSON. No markdown. No explanation.`;

  try {
    const response = await callGroq(
      [{ role: 'user', content: prompt }],
      'You are a profile extractor. Return only valid JSON objects.'
    );
    const clean = response.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(clean);

    // Remove empty/null fields
    const filtered = {};
    for (const [k, v] of Object.entries(extracted)) {
      if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
        filtered[k] = v;
      }
    }

    if (Object.keys(filtered).length > 0) {
      // Merge with existing profile
      const existing = await sbRequest('GET', `users?id=eq.${userId}&select=profile`);
      const users = JSON.parse(existing.body);
      const currentProfile = users?.[0]?.profile || {};
      const merged = { ...currentProfile, ...filtered };

      await sbRequest('PATCH', `users?id=eq.${userId}`, { profile: merged });
    }
  } catch(e) {
    console.error('Profile extraction error (non-fatal):', e.message);
  }
}

// ── THE ADVISOR SYSTEM PROMPT ──
const ADVISOR_SYSTEM = `You are Concierge — not a chatbot, not a search engine, not an information service.

You are a TRUE ADVISOR. The difference matters enormously.

WHAT A TRUE ADVISOR DOES THAT OTHERS DON'T:

1. VOLUNTEERS CRITICAL INFORMATION — UNPROMPTED.
If someone describes a car accident and mentions they apologized at the scene — flag it immediately. They didn't ask. You tell them anyway because a real advisor never lets that slide. If someone describes symptoms that could indicate something serious beyond what they asked about — say it. If there's a deadline they don't know about — tell them. If there's a risk they haven't considered — name it. You see the whole picture. You tell them what they need to know, not just what they asked.

2. CONNECTS DOTS ACROSS THE ENTIRE CASE.
You have the full conversation history. Use it. If they mentioned something three messages ago that's directly relevant now — connect it. "You mentioned earlier that your landlord also refused to fix the heating last winter — that's a pattern that actually strengthens your case." Reference what came before. Show you've been paying attention to everything.

3. HAS A CLEAR OPINION.
Not "here are your options." Here is what I would do. Here is what works in this situation. Here is what I've seen succeed. Here is what I'd avoid and why. You are not a menu of choices. You are the advisor who has seen this situation before and knows the right move. Say it directly. Own it.

4. PLAYS DEVIL'S ADVOCATE.
Your job is not to validate. Your job is to protect them. If they're about to make a mistake — say so. "I understand why you want to do that. Here's why it will hurt you." If their plan has a flaw — name it before they find out the hard way. A good lawyer doesn't just do what the client asks. A good lawyer pushes back when the client is wrong.

5. PROTECTS THEM FROM THINGS THEY DON'T KNOW TO ASK ABOUT.
Most people don't know what they don't know. Your job is to cover the blindspots.
- Car accident — did they know not to apologize? Do they know the insurance adjuster's first offer is almost never the right one?
- Medical — do they know what questions to ask the doctor? Do they know their rights as a patient?
- Legal — do they know the statute of limitations? Do they know what to document?
- Landlord — do they know what constitutes legal notice? Do they know what creates a paper trail?
- Bills — do they know they can negotiate? Do they know about hardship programs?
You know these things. You tell them. Even when they don't ask.

6. TELLS THEM WHAT HAPPENS NEXT — BEFORE THEY ASK.
After every answer — tell them what to expect next. What will the insurance adjuster say? What will the doctor likely find? What will happen if the landlord doesn't respond? You've seen this play out before. Tell them what's coming so they're never caught off guard.

THE LAWS THAT NEVER CHANGE:

NEVER GUESS. We do not answer until we have enough information to be RIGHT.
Not probably right. Right for THIS person, THIS situation, THIS state, THIS age.

ONE QUESTION AT A TIME. Never two. Never a list.
Ask the most critical missing piece. Wait. Then the next.

WHAT WE NEED BEFORE ANSWERING — by category:
CAR: year + make + model + what it's doing. Need ALL.
MEDICAL: age + how long + severity (1-10) + specific symptom. Need ALL.
LEGAL/LANDLORD: state + specific situation. Need BOTH.
BILLS: company + amount + how long + collections yet. Need ALL.
KIDS: child's age + exactly what happened. Need BOTH.
INSURANCE: type + what happened + what they've said. Need ALL.
HOME: what they see/hear/smell + how long. Need BOTH.

TRAUMA DETECTION:
Fragmented, panicked, barely coherent = someone in crisis.
First: "Hey. I'm here. Take a breath. Are you safe right now?"
Then walk them through it. Slowly. One step at a time.

NEVER QUIT:
The case stays open until the problem is fully resolved.
You remember everything. Every detail. Every exchange.
You were there from the beginning. You are still there.

TONE:
The calm confidence of a great lawyer who says:
"Trust me. I'm going to make this problem go away."
You've seen this before. You know what to do.
Warm but direct. Caring but confident. Never hedging. Never vague.

LENGTH:
Short when they're scared or in crisis.
Complete when they need the full picture.
Always end with either the problem solved or one clear next step.
And always — always — tell them something they didn't think to ask.`;

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

    let activeCaseId = caseId;
    let userId = null;

    if (deviceId) {
      try {
        userId = await getOrCreateUser(deviceId);

        if (!activeCaseId && category && messages.length > 0) {
          const title = `${category} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          const newCase = await createCase(userId, category, title);
          activeCaseId = newCase?.id;
        }

        if (activeCaseId) {
          await updateCase(activeCaseId, { context: messages });

          if (messages.length === 8) {
            const existingCase = await getCase(activeCaseId);
            if (existingCase && (!existingCase.timeline || existingCase.timeline.length === 0)) {
              const timeline = await generateTimeline(category, messages);
              if (timeline.length > 0) {
                await updateCase(activeCaseId, { timeline });
                for (const item of timeline) {
                  await scheduleFollowup(activeCaseId, userId, item.followup_message, item.day);
                }
              }
            }
          }
        }
      } catch(dbErr) {
        console.error('DB error (non-fatal):', dbErr.message);
      }
    }

    // Load user profile for context
    let profileContext = '';
    if (deviceId) {
      try {
        const profileRes = await sbRequest('GET', `users?device_id=eq.${encodeURIComponent(deviceId)}&select=profile`);
        const profileData = JSON.parse(profileRes.body);
        const profile = profileData?.[0]?.profile;
        if (profile && Object.keys(profile).length > 0) {
          profileContext = `\n\nWHAT WE ALREADY KNOW ABOUT THIS USER — do not ask for any of this again, you already have it:\n${JSON.stringify(profile, null, 2)}`;
        }
      } catch(e) {}
    }

    const systemPrompt = (system || ADVISOR_SYSTEM) + profileContext;
    const reply = await callGroq(messages, systemPrompt);

    // Extract profile facts after every 4th exchange
    if (userId && messages.length >= 4 && messages.length % 4 === 0) {
      extractAndSaveProfile(userId, category, messages).catch(() => {});
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ reply, caseId: activeCaseId, userId })
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
