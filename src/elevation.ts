export interface ElevationSelection {
  longitude: number;
  latitude: number;
  sizeMetres: number;
}

export interface ElevationModel {
  source: string;
  zoom: number;
  anchorElevationMetres: number;
  sampleAbsoluteLocal(xMetres: number, yMetres: number): number;
  sampleRelativeLocal(xMetres: number, yMetres: number): number;
}

type ElevationGrid = {
  width: number;
  height: number;
  values: Float32Array;
  source: string;
};

export async function loadElevationModel(selection: ElevationSelection): Promise<ElevationModel> {
  const gridSize = Math.round(selection.sizeMetres);
  const query = new URLSearchParams({
    lat: selection.latitude.toFixed(9),
    lon: selection.longitude.toFixed(9),
    size: String(Math.round(selection.sizeMetres)),
    grid: String(gridSize),
  });
  const response = await fetch(`/api/elevation-grid?${query.toString()}`);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Official DMR 5.0 request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const width = parseHeaderInteger(response.headers.get('X-TriWorld-Grid-Width'), 'grid width');
  const height = parseHeaderInteger(response.headers.get('X-TriWorld-Grid-Height'), 'grid height');
  const source = response.headers.get('X-TriWorld-Elevation-Source') ?? 'GKÚ SR DMR 5.0 WCS';
  const arrayBuffer = await response.arrayBuffer();
  const values = new Float32Array(arrayBuffer);
  if (values.length !== width * height) {
    throw new Error(`Elevation payload has ${values.length} samples, expected ${width * height}`);
  }

  const grid: ElevationGrid = { width, height, values, source };
  const anchorElevationMetres = sampleGrid(grid, 0, 0, selection.sizeMetres);
  const sampledRange = computeRange(values);
  if (sampledRange.maximum - sampledRange.minimum < 0.25) {
    throw new Error('Official DMR grid is unexpectedly flat; refusing to build an invalid terrain');
  }

  const sampleAbsoluteLocal = (xMetres: number, yMetres: number): number => (
    sampleGrid(grid, xMetres, yMetres, selection.sizeMetres)
  );

  return {
    source: `${source} · Native 1.0m LiDAR (${width}×${height} samples)`,
    zoom: 0,
    anchorElevationMetres,
    sampleAbsoluteLocal,
    sampleRelativeLocal(xMetres: number, yMetres: number): number {
      return sampleAbsoluteLocal(xMetres, yMetres) - anchorElevationMetres;
    },
  };
}

/**
 * GeoTIFF rows are north-to-south. Canonical local Y is positive north.
 * Therefore local north maps to raster row 0 and local south maps to the last row.
 */
function sampleGrid(grid: ElevationGrid, xMetres: number, yMetres: number, sizeMetres: number): number {
  const half = sizeMetres / 2;
  const u = clamp((xMetres + half) / sizeMetres, 0, 1);
  const v = clamp((half - yMetres) / sizeMetres, 0, 1);
  const pixelX = u * (grid.width - 1);
  const pixelY = v * (grid.height - 1);
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = pixelX - x0;
  const ty = pixelY - y0;
  const northWest = grid.values[y0 * grid.width + x0];
  const northEast = grid.values[y0 * grid.width + x1];
  const southWest = grid.values[y1 * grid.width + x0];
  const southEast = grid.values[y1 * grid.width + x1];
  const north = mix(northWest, northEast, tx);
  const south = mix(southWest, southEast, tx);
  return mix(north, south, ty);
}

function computeRange(values: Float32Array): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error('Elevation grid contains no finite samples');
  }
  return { minimum, maximum };
}

function parseHeaderInteger(value: string | null, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 4096) {
    throw new Error(`Invalid ${label} header: ${value ?? 'missing'}`);
  }
  return parsed;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
