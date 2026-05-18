const https = require('https');

const SUPABASE_URL = 'https://erlfsyarkcsthrwrdenz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVybGZzeWFya2NzdGhyd3JkZW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMTk3NzQsImV4cCI6MjA5NDY5NTc3NH0.pB3TTg6zTHqmGrAOoQMB5ql0FxSvYUpOjesq2ZT6IeM';

async function query(sql) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: 'erlfsyarkcsthrwrdenz.supabase.co',
      path: '/rest/v1/rpc/exec_sql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
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
}

exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Use Supabase SQL editor to run schema' })
  };
};
