const DEFAULT_BBOX = [
  18.329824469320165,
  48.723767603828456,
  18.357063678856335,
  48.74173382732828,
];

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const bbox = parseBbox(request.query?.bbox);
    const url = new URL('https://api.openstreetmap.org/api/0.6/map.json');
    url.searchParams.set('bbox', bbox.join(','));

    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TriWorld/0.5 (+https://triworld.vercel.app; contact: tomisu76@gmail.com)',
      },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return response.status(502).json({
        error: 'OpenStreetMap request failed',
        upstreamStatus: upstream.status,
        details: text.slice(0, 500),
      });
    }

    const payload = await upstream.json();
    response.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(200).json({
      bbox,
      fetchedAt: new Date().toISOString(),
      source: 'OpenStreetMap API v0.6',
      data: payload,
    });
  } catch (error) {
    return response.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown server error',
    });
  }
}

function parseBbox(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_BBOX;

  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((number) => !Number.isFinite(number))) {
    throw new Error('bbox must be left,bottom,right,top');
  }

  const [left, bottom, right, top] = parts;
  if (left >= right || bottom >= top) throw new Error('bbox bounds are invalid');
  if (right - left > 0.08 || top - bottom > 0.08) {
    throw new Error('bbox is too large for the TriWorld prototype');
  }

  return parts;
}
