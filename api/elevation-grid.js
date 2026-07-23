import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';

const COVERAGE = 'el:EL.GridCoverage';
const WCS_URL = 'https://inspirews.skgeodesy.sk/geoserver/el/ows';
const MAX_SIZE_METRES = 4000;
const MIN_GRID_SIZE = 81;
const MAX_GRID_SIZE = 401;
const SLOVAKIA_BOUNDS = { west: 16.83, south: 47.73, east: 22.57, north: 49.61 };

proj4.defs(
  'EPSG:25834',
  '+proj=utm +zone=34 +ellps=GRS80 +units=m +no_defs +type=crs',
);

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const latitude = parseNumber(request.query?.lat, 'lat');
    const longitude = parseNumber(request.query?.lon, 'lon');
    const sizeMetres = parseNumber(request.query?.size, 'size');
    const requestedGridSize = request.query?.grid === undefined
      ? Math.round(sizeMetres / 12.5) + 1
      : parseInteger(request.query.grid, 'grid');
    const gridSize = clamp(requestedGridSize, MIN_GRID_SIZE, MAX_GRID_SIZE);

    validateSelection(latitude, longitude, sizeMetres);

    const [easting, northing] = proj4('EPSG:4326', 'EPSG:25834', [longitude, latitude]);
    const half = sizeMetres / 2;
    const west = easting - half;
    const south = northing - half;
    const east = easting + half;
    const north = northing + half;

    const coverage = await fetchCoverage({ west, south, east, north, gridSize });
    const decoded = await decodeCoverage(coverage, gridSize);

    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('X-TriWorld-Grid-Width', String(decoded.width));
    response.setHeader('X-TriWorld-Grid-Height', String(decoded.height));
    response.setHeader('X-TriWorld-Elevation-Source', 'GKÚ SR DMR 5.0 WCS');
    response.setHeader('X-TriWorld-Elevation-CRS', 'EPSG:25834');
    response.setHeader('X-TriWorld-Elevation-Min', String(decoded.minimum));
    response.setHeader('X-TriWorld-Elevation-Max', String(decoded.maximum));
    response.setHeader('X-TriWorld-Elevation-NoData', String(decoded.noDataCount));
    return response.status(200).send(Buffer.from(decoded.values.buffer));
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : 'Elevation service failed',
    });
  }
}

async function fetchCoverage({ west, south, east, north, gridSize }) {
  const attempts = [
    buildWcsUrl({
      crs: 'EPSG:25834',
      bbox: [west, south, east, north],
      gridSize,
    }),
    buildWcsUrl({
      crs: 'EPSG:3046',
      bbox: [south, west, north, east],
      gridSize,
    }),
  ];

  const failures = [];
  for (const url of attempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'image/tiff, application/geotiff, application/octet-stream',
          'User-Agent': 'TriWorld/0.7 (+https://triworld.vercel.app; contact: tomisu76@gmail.com)',
        },
      });
      if (!upstream.ok) {
        failures.push(`${upstream.status} ${await upstream.text().then((text) => text.slice(0, 180))}`);
        continue;
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      const bytes = await upstream.arrayBuffer();
      if (bytes.byteLength < 1024 || /xml|json|text/i.test(contentType)) {
        failures.push(`unexpected ${contentType || 'content'} (${bytes.byteLength} bytes)`);
        continue;
      }
      return bytes;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Official DMR 5.0 WCS request failed: ${failures.join(' | ')}`);
}

function buildWcsUrl({ crs, bbox, gridSize }) {
  const url = new URL(WCS_URL);
  url.searchParams.set('service', 'WCS');
  url.searchParams.set('version', '1.0.0');
  url.searchParams.set('request', 'GetCoverage');
  url.searchParams.set('coverage', COVERAGE);
  url.searchParams.set('format', 'GeoTIFF');
  url.searchParams.set('crs', crs);
  url.searchParams.set('response_crs', crs);
  url.searchParams.set('bbox', bbox.join(','));
  url.searchParams.set('width', String(gridSize));
  url.searchParams.set('height', String(gridSize));
  return url;
}

async function decodeCoverage(arrayBuffer, expectedGridSize) {
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (width < 2 || height < 2 || width > MAX_GRID_SIZE + 8 || height > MAX_GRID_SIZE + 8) {
    throw new Error(`Unexpected DMR raster size ${width}x${height}`);
  }
  if (Math.abs(width - expectedGridSize) > 8 || Math.abs(height - expectedGridSize) > 8) {
    throw new Error(`DMR raster size ${width}x${height} differs from requested ${expectedGridSize}`);
  }

  const rasters = await image.readRasters({ interleave: true });
  const source = rasters;
  const values = new Float32Array(width * height);
  const noDataRaw = image.getGDALNoData();
  const noData = noDataRaw === null ? null : Number(noDataRaw);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let noDataCount = 0;

  for (let index = 0; index < values.length; index++) {
    const value = Number(source[index]);
    const invalid = !Number.isFinite(value)
      || (noData !== null && Math.abs(value - noData) < 1e-5)
      || value < -500
      || value > 3000;
    if (invalid) {
      values[index] = Number.NaN;
      noDataCount += 1;
      continue;
    }
    values[index] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }

  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error('Official DMR coverage contains no valid elevation samples');
  }
  if (noDataCount > values.length * 0.02) {
    throw new Error(`Official DMR coverage contains too much NoData (${noDataCount}/${values.length})`);
  }
  if (maximum - minimum > 1800) {
    throw new Error(`Official DMR relief is implausible (${(maximum - minimum).toFixed(1)} m)`);
  }

  fillNoData(values, width, height);
  return { values, width, height, minimum, maximum, noDataCount };
}

function fillNoData(values, width, height) {
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    const copy = values.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (Number.isFinite(copy[index])) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const candidate = copy[ny * width + nx];
            if (!Number.isFinite(candidate)) continue;
            sum += candidate;
            count += 1;
          }
        }
        if (count > 0) {
          values[index] = sum / count;
          changed += 1;
        }
      }
    }
    if (changed === 0) break;
  }

  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) {
      throw new Error('Unable to interpolate remaining DMR NoData cells');
    }
  }
}

function validateSelection(latitude, longitude, sizeMetres) {
  if (latitude < SLOVAKIA_BOUNDS.south || latitude > SLOVAKIA_BOUNDS.north
    || longitude < SLOVAKIA_BOUNDS.west || longitude > SLOVAKIA_BOUNDS.east) {
    throw new Error('Official DMR 5.0 mode currently supports Slovakia only');
  }
  if (sizeMetres < 500 || sizeMetres > MAX_SIZE_METRES) {
    throw new Error(`size must be between 500 and ${MAX_SIZE_METRES} metres`);
  }
}

function parseNumber(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function parseInteger(value, name) {
  const parsed = parseNumber(value, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
