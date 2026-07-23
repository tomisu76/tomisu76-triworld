const MAX_ZOOM = 15;

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const z = parseInteger(request.query?.z, 'z');
    const x = parseInteger(request.query?.x, 'x');
    const y = parseInteger(request.query?.y, 'y');
    const tileCount = 2 ** z;

    if (z < 0 || z > MAX_ZOOM) throw new Error(`z must be between 0 and ${MAX_ZOOM}`);
    if (x < 0 || x >= tileCount || y < 0 || y >= tileCount) throw new Error('Tile coordinate is outside the zoom grid');

    const upstreamUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'image/png',
        'User-Agent': 'TriWorld/0.6 (+https://triworld.vercel.app; contact: tomisu76@gmail.com)',
      },
    });

    if (!upstream.ok) {
      return response.status(502).json({
        error: 'Terrain tile request failed',
        upstreamStatus: upstream.status,
        tile: `${z}/${x}/${y}`,
      });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(200).send(bytes);
  } catch (error) {
    return response.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid elevation tile request',
    });
  }
}

function parseInteger(value, name) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}
