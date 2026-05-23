const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No API key' }) };

  try {
    const { query, location, type } = JSON.parse(event.body);
    // Build search query
    const searchQuery = encodeURIComponent(`${query} near ${location}`);
    const path = `/maps/api/place/textsearch/json?query=${searchQuery}&key=${apiKey}`;

    const result = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'maps.googleapis.com',
        path,
        headers: { 'Accept': 'application/json' }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }).on('error', reject);
    });

    const data = JSON.parse(result.body);
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API: ${data.status} — ${data.error_message || ''}`);
    }

    // Return top 3 results cleaned up
    const places = (data.results || []).slice(0, 3).map(p => ({
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
      body: JSON.stringify({ places, status: data.status })
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
