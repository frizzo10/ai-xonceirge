const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function googleSearch(text, apiKey) {
  const path = `/maps/api/place/textsearch/json?query=${encodeURIComponent(text)}&region=us&key=${apiKey}`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'maps.googleapis.com', path, headers: { 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// The AI words the search differently every time ("auto repair near 28607",
// "auto repair near user's location", "auto repair near city"...). Don't depend on it:
// take just the business type, then try a few phrasings Google handles well.
function buildQueries(query, location) {
  let base = String(query || '').replace(/\s+(near|in|around)\s+.*$/i, '').trim() || 'auto repair';
  const loc = String(location || '').trim();
  if (!loc) return [base];
  return [
    `${base} near ${loc}`,
    `${base} in ${loc} USA`,
    `${base} ${loc}`,
    `${query} near ${loc}` // original behavior, last resort
  ].filter((q, i, a) => a.indexOf(q) === i);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  try {
    const { query, location } = JSON.parse(event.body);
    const attempts = [];
    let data = null;

    for (const text of buildQueries(query, location)) {
      const d = await googleSearch(text, apiKey);
      attempts.push({ text, status: d.status, count: (d.results || []).length, error: d.error_message || undefined });
      console.log('Places try:', JSON.stringify(attempts[attempts.length - 1]));
      if (d.status === 'OK' && (d.results || []).length > 0) { data = d; break; }
      // A key/billing problem won't fix itself by rewording — stop and report it
      if (d.status === 'REQUEST_DENIED' || d.status === 'INVALID_REQUEST') break;
    }

    const places = ((data && data.results) || []).slice(0, 3).map(p => ({
      name: p.name,
      address: p.formatted_address,
      rating: p.rating,
      open_now: p.opening_hours?.open_now,
      phone: p.formatted_phone_number || null,
      place_id: p.place_id
    }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ places, status: places.length ? 'OK' : 'ZERO_RESULTS', attempts })
    };

  } catch (err) {
    console.error('Places error:', err.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
