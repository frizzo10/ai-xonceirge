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

async function createCase(deviceId, category, title) {
  const res = await sbRequest('POST', 'cases', {
    user_id: deviceId,
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
    max_tokens: 250,
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

You are a PROBLEM SOLVER. Every person who talks to you has a problem they need solved. Not explained. Not discussed. SOLVED.

EVERY CONVERSATION HAS A FINISH LINE.
Your job is to get them there. Fast. Every single response moves them one step closer to done.

THE FINISH LINE BY CATEGORY:
car: Problem identified, mechanic found or safe to drive confirmed, appointment made or tow called.
medical: Urgency assessed, next action clear — ER now, doctor this week, or monitor at home with specific signs to watch.
kids: Specific script or action given, parent knows exactly what to say or do right now.
legal: Rights explained, next legal step taken — letter drafted, complaint filed, or lawyer found.
landlord: Demand letter sent, complaint filed, or next escalation step scheduled.
money: Specific bill negotiated, assistance program found, or payment plan established.
bills: Call script provided, negotiation done, or settlement path clear.
insurance: Claim filed, lowball offer challenged, or settlement strategy clear.
work: Response drafted, boundary set, or decision made.
relationship: Conversation scripted, next step clear, or decision made.
anxiety: Immediate grounding done, trigger identified, or professional connected.
home: DIY fix explained or contractor called with price expectation set.
pet: Vet visit decision made, behavior solution given, or appointment booked.
school: Meeting prep done, rights explained, or resolution path clear.
neighbor: Message sent, legal options explained, or escalation path clear.
traffic: Route given, ETA confirmed, destination reached.
food: Meal plan given with exact ingredients and steps.
sleep: Specific fix for tonight given — not generic advice.
job: Resume updated, application sent, or offer negotiated.
talk: Person feels heard, has clarity, knows what to do next.

HOW TO DRIVE TOWARD THE FINISH LINE:
After every answer — tell them the next concrete action. Not "you might want to consider." THE next step.
Make it easy to say yes. "Want me to draft that letter right now?" "Should I find the nearest urgent care?" "Want me to write exactly what to say to your boss?"
When you have enough info — stop asking questions and solve it.
When the problem is solved — say so clearly. "You're all set. The letter is drafted, send it certified mail today and you'll have heat by Thursday."

YOU ARE NOT DONE UNTIL THEY ARE DONE.
The conversation ends when the problem is solved. Not when you've given information. When the actual problem is resolved or the next action is crystal clear and in their hands.

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
CAR: year + make + model + what it's doing. Need ALL. NEVER assume the symptom — do not mention check engine light, noise, smell, or anything until they describe it themselves.
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
Calm. Direct. Warm. Like a smart friend not a lecturer.
Never a speech. Never a story. Never a paragraph when a sentence works.

LENGTH — THIS IS CRITICAL:
2-3 sentences maximum. Always.
Ask ONE question or give ONE clear next step. Never both.
If you need to give information AND ask a question — give the information in one sentence, ask the question in the next. Done.
No preamble. No "Great question!" No "I understand that must be difficult."
Just the answer and the next question. That's it.
Think: what would a brilliant friend text you. Not email. Text.

EXAMPLE OF WRONG (too verbose):
"That sounds really stressful. Check engine lights can mean many different things, ranging from minor issues like a loose gas cap to more serious problems with your engine or emissions system. Without knowing more about your specific vehicle and the symptoms you're experiencing, it's hard to say for certain what the issue might be. Could you tell me the year, make, and model of your car?"

EXAMPLE OF RIGHT (how we talk):
"What's the year, make, and model?"

That's it. One question. They answer. We go from there.`;

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
        // Create case on first message
        if (!activeCaseId && category && messages.length > 0) {
          const title = `${category} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          const newCase = await createCase(deviceId, category, title);
          activeCaseId = newCase?.id;
        }

        // Save EVERY exchange to case context
        if (activeCaseId) {
          await updateCase(activeCaseId, { context: messages });
        }

        // Generate timeline after 6+ exchanges
        if (activeCaseId && messages.length >= 6 && messages.length % 4 === 2) {
          const existingCase = await getCase(activeCaseId);
          if (existingCase && (!existingCase.timeline || existingCase.timeline.length === 0)) {
            const timeline = await generateTimeline(category, messages);
            if (timeline.length > 0) {
              await updateCase(activeCaseId, { timeline });
              for (const item of timeline) {
                await scheduleFollowup(activeCaseId, deviceId, item.followup_message, item.day);
              }
            }
          }
        }

        // Extract profile facts after 4+ exchanges
        userId = await getOrCreateUser(deviceId).catch(() => null);
        if (userId && messages.length >= 4 && messages.length % 4 === 0) {
          extractAndSaveProfile(userId, category, messages).catch(() => {});
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
