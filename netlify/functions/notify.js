const https = require('https');

const ONESIGNAL_APP_ID = '86036a53-6c90-4405-8bf3-e4ea760df89b';
const ONESIGNAL_KEY = process.env.ONESIGNAL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

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

async function sendPushNotification(externalId, title, message, caseId) {
  const payload = JSON.stringify({
    app_id: ONESIGNAL_APP_ID,
    include_aliases: { external_id: [externalId] },
    target_channel: 'push',
    headings: { en: title },
    contents: { en: message },
    url: `https://aiconcerige.netlify.app/app.html?case=${caseId}`,
    web_url: `https://aiconcerige.netlify.app/app.html?case=${caseId}`,
    chrome_web_icon: 'https://aiconcerige.netlify.app/icons/icon-192.png',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.onesignal.com',
      path: '/notifications',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${ONESIGNAL_KEY}`,
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
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // GET = cron job trigger — check for due followups
  if (event.httpMethod === 'GET') {
    try {
      const now = new Date().toISOString();
      // Get all unsent followups that are due
      const res = await sbRequest('GET',
        `followups?sent=eq.false&scheduled_for=lte.${now}&select=*,cases(user_id,title,category,status)`
      );
      const followups = JSON.parse(res.body);

      if (!followups || followups.length === 0) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0 }) };
      }

      let sent = 0;
      for (const f of followups) {
        const caseData = f.cases;
        if (!caseData || caseData.status === 'resolved') continue;

        const userId = f.user_id;
        const title = `Concierge — ${caseData.category}`;
        const message = f.message;

        try {
          const result = await sendPushNotification(userId, title, message, f.case_id);
          console.log('Notification sent:', result.status, result.body);

          // Mark as sent
          await sbRequest('PATCH', `followups?id=eq.${f.id}`, { sent: true });
          sent++;
        } catch(e) {
          console.error('Failed to send notification:', e.message);
        }
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent, total: followups.length }) };
    } catch(e) {
      console.error('Cron error:', e.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POST = register a device for push notifications
  if (event.httpMethod === 'POST') {
    try {
      const { deviceId, oneSignalId } = JSON.parse(event.body);
      // Store OneSignal player ID against device ID in Supabase
      await sbRequest('PATCH',
        `users?device_id=eq.${encodeURIComponent(deviceId)}`,
        { onesignal_id: oneSignalId }
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
