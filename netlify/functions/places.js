const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// The AI sometimes sends "auto repair near city" (copying the placeholder) or its own
// location guess. Strip any trailing "near ..." and use the user's saved location instead.
function buildQuery(query, location) {
  let base = String(query || '').trim();
  if (location) base = base.replace(/\s+(near|in|around)\s+.*$/i, '').trim();
  if (!base) base = 'auto repair';
  return location ? `${base} near ${location}` : base;
}

// Places API (New) — the current Google API
async function searchNew(textQuery, apiKey) {
  const payload = JSON.stringify({ textQuery, pageSize: 3 });
  const res = await request({
    hostname: 'places.googleapis.com',
    path: '/v1/places:searchText',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.currentOpeningHours.openNow,places.nationalPhoneNumber'
    }
  }, payload);
  const data = JSON.parse(res.body || '{}');
  if (res.status !== 200) throw new Error('Places (New): ' + res.status + ' ' + (data.error?.message || ''));
  return (data.places || []).slice(0, 3).map(p => ({
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    rating: p.rating,
    open_now: p.currentOpeningHours?.openNow,
    phone: p.nationalPhoneNumber || null,
    place_id: p.id
  }));
}

// Legacy Places API — fallback in case only the old API is enabled on the key
async function searchLegacy(textQuery, apiKey) {
  const path = `/maps/api/place/textsearch/json?query=${encodeURIComponent(textQuery)}&key=${apiKey}`;
  const res = await request({ hostname: 'maps.googleapis.com', path, method: 'GET', headers: { 'Accept': 'application/json' } });
  const data = JSON.parse(res.body || '{}');
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places (legacy): ${data.status} — ${data.error_message || ''}`);
  }
  return (data.results || []).slice(0, 3).map(p => ({
    name: p.name,
    address: p.formatted_address,
    rating: p.rating,
    open_now: p.opening_hours?.open_now,
    phone: p.formatted_phone_number || null,
    place_id: p.place_id
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  try {
    const { query, location } = JSON.parse(event.body);
    const textQuery = buildQuery(query, location);

    let places = [];
    const errors = [];
    try {
      places = await searchNew(textQuery, apiKey);
    } catch (e) {
      errors.push(e.message);
      console.error(e.message);
    }
    if (places.length === 0) {
      try {
        places = await searchLegacy(textQuery, apiKey);
      } catch (e) {
        errors.push(e.message);
        console.error(e.message);
      }
    }
    if (places.length === 0 && errors.length === 2) throw new Error(errors.join(' | '));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ places, status: places.length ? 'OK' : 'ZERO_RESULTS', query: textQuery })
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
