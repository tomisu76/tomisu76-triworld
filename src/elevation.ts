const TILE_SIZE = 256;
const TERRAIN_ZOOM = 14;
const MAX_CONCURRENT_REQUESTS = 6;

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

type TileCoordinate = { x: number; y: number };
type DecodedTile = TileCoordinate & { pixels: Uint8ClampedArray };

export async function loadElevationModel(selection: ElevationSelection): Promise<ElevationModel> {
  const bounds = selectionBounds(selection);
  const tileCoordinates = tilesForBounds(bounds, TERRAIN_ZOOM, 1);
  const tiles = await loadTiles(tileCoordinates, TERRAIN_ZOOM);
  const tileMap = new Map(tiles.map((tile) => [tileKey(tile.x, tile.y), tile]));

  const sampleAbsoluteGeographic = (longitude: number, latitude: number): number => {
    const global = longitudeLatitudeToGlobalPixel(longitude, latitude, TERRAIN_ZOOM);
    const pixelX = global.x - 0.5;
    const pixelY = global.y - 0.5;
    const x0 = Math.floor(pixelX);
    const y0 = Math.floor(pixelY);
    const tx = pixelX - x0;
    const ty = pixelY - y0;

    const h00 = readGlobalPixel(tileMap, x0, y0, TERRAIN_ZOOM);
    const h10 = readGlobalPixel(tileMap, x0 + 1, y0, TERRAIN_ZOOM);
    const h01 = readGlobalPixel(tileMap, x0, y0 + 1, TERRAIN_ZOOM);
    const h11 = readGlobalPixel(tileMap, x0 + 1, y0 + 1, TERRAIN_ZOOM);
    const north = mix(h00, h10, tx);
    const south = mix(h01, h11, tx);
    return mix(north, south, ty);
  };

  const anchorElevationMetres = sampleAbsoluteGeographic(selection.longitude, selection.latitude);
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((selection.latitude * Math.PI) / 180);

  const sampleAbsoluteLocal = (xMetres: number, yMetres: number): number => {
    const longitude = selection.longitude + xMetres / metresPerDegreeLongitude;
    const latitude = selection.latitude + yMetres / metresPerDegreeLatitude;
    return sampleAbsoluteGeographic(longitude, latitude);
  };

  return {
    source: `Mapzen Terrain Tiles on AWS Open Data · Terrarium z${TERRAIN_ZOOM}`,
    zoom: TERRAIN_ZOOM,
    anchorElevationMetres,
    sampleAbsoluteLocal,
    sampleRelativeLocal(xMetres: number, yMetres: number): number {
      return sampleAbsoluteLocal(xMetres, yMetres) - anchorElevationMetres;
    },
  };
}

async function loadTiles(coordinates: TileCoordinate[], zoom: number): Promise<DecodedTile[]> {
  const result = new Array<DecodedTile>(coordinates.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, coordinates.length) }, async () => {
    while (cursor < coordinates.length) {
      const index = cursor++;
      const coordinate = coordinates[index];
      result[index] = await loadTile(coordinate.x, coordinate.y, zoom);
    }
  });
  await Promise.all(workers);
  return result;
}

async function loadTile(x: number, y: number, zoom: number): Promise<DecodedTile> {
  const proxyUrl = `/api/elevation-tile?z=${zoom}&x=${x}&y=${y}`;
  const directUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
  let response = await fetch(proxyUrl);

  if (!response.ok && import.meta.env.DEV) {
    response = await fetch(directUrl);
  }

  if (!response.ok) {
    throw new Error(`Elevation tile ${zoom}/${x}/${y} failed (${response.status}).`);
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('Canvas 2D is unavailable for elevation decoding.');
  }

  context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close();
  const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  return { x, y, pixels };
}

function readGlobalPixel(
  tiles: Map<string, DecodedTile>,
  globalPixelX: number,
  globalPixelY: number,
  zoom: number,
): number {
  const tileCount = 2 ** zoom;
  const tileXUnwrapped = floorDivide(globalPixelX, TILE_SIZE);
  const tileY = clamp(floorDivide(globalPixelY, TILE_SIZE), 0, tileCount - 1);
  const tileX = positiveModulo(tileXUnwrapped, tileCount);
  const pixelX = positiveModulo(globalPixelX, TILE_SIZE);
  const pixelY = positiveModulo(globalPixelY, TILE_SIZE);
  const tile = tiles.get(tileKey(tileX, tileY));
  if (!tile) throw new Error(`Elevation tile ${zoom}/${tileX}/${tileY} was not loaded.`);

  const offset = (pixelY * TILE_SIZE + pixelX) * 4;
  const red = tile.pixels[offset];
  const green = tile.pixels[offset + 1];
  const blue = tile.pixels[offset + 2];
  return red * 256 + green + blue / 256 - 32_768;
}

function tilesForBounds(
  bounds: readonly [number, number, number, number],
  zoom: number,
  marginTiles: number,
): TileCoordinate[] {
  const [west, south, east, north] = bounds;
  const northWest = longitudeLatitudeToTile(west, north, zoom);
  const southEast = longitudeLatitudeToTile(east, south, zoom);
  const tileCount = 2 ** zoom;
  const minX = Math.floor(Math.min(northWest.x, southEast.x)) - marginTiles;
  const maxX = Math.floor(Math.max(northWest.x, southEast.x)) + marginTiles;
  const minY = Math.max(0, Math.floor(Math.min(northWest.y, southEast.y)) - marginTiles);
  const maxY = Math.min(tileCount - 1, Math.floor(Math.max(northWest.y, southEast.y)) + marginTiles);
  const coordinates: TileCoordinate[] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      coordinates.push({ x: positiveModulo(x, tileCount), y });
    }
  }
  return coordinates;
}

function selectionBounds(selection: ElevationSelection): readonly [number, number, number, number] {
  const halfExtent = selection.sizeMetres / 2;
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((selection.latitude * Math.PI) / 180);
  const latitudeDelta = halfExtent / metresPerDegreeLatitude;
  const longitudeDelta = halfExtent / metresPerDegreeLongitude;
  return [
    selection.longitude - longitudeDelta,
    selection.latitude - latitudeDelta,
    selection.longitude + longitudeDelta,
    selection.latitude + latitudeDelta,
  ];
}

function longitudeLatitudeToGlobalPixel(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const tile = longitudeLatitudeToTile(longitude, latitude, zoom);
  return { x: tile.x * TILE_SIZE, y: tile.y * TILE_SIZE };
}

function longitudeLatitudeToTile(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const tileCount = 2 ** zoom;
  const safeLatitude = clamp(latitude, -85.05112878, 85.05112878);
  const latitudeRadians = (safeLatitude * Math.PI) / 180;
  const x = ((longitude + 180) / 360) * tileCount;
  const y = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * tileCount;
  return { x, y };
}

function floorDivide(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function tileKey(x: number, y: number): string {
  return `${x}/${y}`;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
