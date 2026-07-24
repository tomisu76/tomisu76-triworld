import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { utm34NToWgs84 } from './geodetic-transformer';

export const SITECHECK_SIZE = 1024;
export const SITECHECK_MAX_HEIGHT = 500.0;
export const SITECHECK_DEM_ZOOM = 14;
export const SITECHECK_DEM_COARSE_SIZE = 257;
const HALF_EXTENT = SITECHECK_SIZE / 2;

export interface SitecheckTerrain {
  elevations: Float32Array;
  heightMapU16: Uint16Array;
  layerMapU8: Uint8Array;
  heightScale: number;
  minElevation: number;
  maxElevation: number;
  tileCount: number;
  sample: (x: number, y: number) => number;
}

export function buildSitecheckTerrain(
  demRoot: string,
  centerUtm: { easting: number; northing: number },
): SitecheckTerrain {
  const tileMap = loadDemTiles(demRoot);
  console.log(
    `Sampling cached Terrarium DEM on ${SITECHECK_DEM_COARSE_SIZE}x` +
    `${SITECHECK_DEM_COARSE_SIZE} control grid...`,
  );

  const coarse = new Float64Array(
    SITECHECK_DEM_COARSE_SIZE * SITECHECK_DEM_COARSE_SIZE,
  );
  const coarseStep =
    (SITECHECK_SIZE - 1) / (SITECHECK_DEM_COARSE_SIZE - 1);

  for (let row = 0; row < SITECHECK_DEM_COARSE_SIZE; row += 1) {
    const localY = row * coarseStep;
    const northing = centerUtm.northing - HALF_EXTENT + 0.5 + localY;

    for (let column = 0; column < SITECHECK_DEM_COARSE_SIZE; column += 1) {
      const localX = column * coarseStep;
      const easting = centerUtm.easting - HALF_EXTENT + 0.5 + localX;
      const wgs = utm34NToWgs84(easting, northing, 0);
      coarse[row * SITECHECK_DEM_COARSE_SIZE + column] = sampleDem(
        wgs.longitude,
        wgs.latitude,
        tileMap,
      );
    }
  }

  console.log('Upsampling terrain to 1024x1024 BeamNG heightfield...');

  const elevations = new Float32Array(SITECHECK_SIZE * SITECHECK_SIZE);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (let terrainRow = 0; terrainRow < SITECHECK_SIZE; terrainRow += 1) {
    const localY = SITECHECK_SIZE - 1 - terrainRow;
    const coarseY = localY / coarseStep;
    const y0 = Math.min(
      SITECHECK_DEM_COARSE_SIZE - 2,
      Math.floor(coarseY),
    );
    const y1 = y0 + 1;
    const ty = coarseY - y0;

    for (let column = 0; column < SITECHECK_SIZE; column += 1) {
      const coarseX = column / coarseStep;
      const x0 = Math.min(
        SITECHECK_DEM_COARSE_SIZE - 2,
        Math.floor(coarseX),
      );
      const x1 = x0 + 1;
      const tx = coarseX - x0;

      const z00 = coarse[y0 * SITECHECK_DEM_COARSE_SIZE + x0];
      const z10 = coarse[y0 * SITECHECK_DEM_COARSE_SIZE + x1];
      const z01 = coarse[y1 * SITECHECK_DEM_COARSE_SIZE + x0];
      const z11 = coarse[y1 * SITECHECK_DEM_COARSE_SIZE + x1];
      const z0 = z00 + (z10 - z00) * tx;
      const z1 = z01 + (z11 - z01) * tx;
      const elevation = z0 + (z1 - z0) * ty;

      elevations[terrainRow * SITECHECK_SIZE + column] = elevation;
      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  if (minElevation < 0 || maxElevation > SITECHECK_MAX_HEIGHT) {
    throw new Error(
      `SITECHECK01 rejected: DEM range ${minElevation.toFixed(3)}..` +
      `${maxElevation.toFixed(3)}m does not fit maxHeight ` +
      `${SITECHECK_MAX_HEIGHT}m.`,
    );
  }

  const heightScale = SITECHECK_MAX_HEIGHT / 65535.0;
  const heightMapU16 = new Uint16Array(SITECHECK_SIZE * SITECHECK_SIZE);
  for (let index = 0; index < elevations.length; index += 1) {
    heightMapU16[index] = Math.max(
      0,
      Math.min(65535, Math.round(elevations[index] / heightScale)),
    );
  }

  return {
    elevations,
    heightMapU16,
    layerMapU8: new Uint8Array(SITECHECK_SIZE * SITECHECK_SIZE),
    heightScale,
    minElevation,
    maxElevation,
    tileCount: tileMap.size,
    sample: createTerrainSampler(elevations),
  };
}

function listPngFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
        result.push(full);
      }
    }
  };
  walk(root);
  return result.sort();
}

function loadDemTiles(demRoot: string): Map<string, PNG> {
  const map = new Map<string, PNG>();
  for (const filePath of listPngFiles(demRoot)) {
    const normalized = filePath.replaceAll('\\', '/');
    const match = normalized.match(/\/14\/(\d+)\/(\d+)\.png$/);
    if (!match) continue;
    map.set(`${match[1]}/${match[2]}`, PNG.sync.read(fs.readFileSync(filePath)));
  }

  if (map.size !== 12) {
    throw new Error(
      `SITECHECK01 rejected: expected 12 cached DEM tiles, found ${map.size}.`,
    );
  }
  return map;
}

function decodeTerrarium(png: PNG, x: number, y: number): number {
  const index = (y * png.width + x) * 4;
  return (
    png.data[index] * 256 +
    png.data[index + 1] +
    png.data[index + 2] / 256 -
    32768
  );
}

function sampleDem(
  longitude: number,
  latitude: number,
  tileMap: ReadonlyMap<string, PNG>,
): number {
  const tileCount = 2 ** SITECHECK_DEM_ZOOM;
  const radians = latitude * Math.PI / 180;
  const globalX = ((longitude + 180) / 360) * tileCount * 256 - 0.5;
  const globalY = (
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
    2
  ) * tileCount * 256 - 0.5;

  const x0 = Math.floor(globalX);
  const y0 = Math.floor(globalY);
  const tx = globalX - x0;
  const ty = globalY - y0;

  const read = (pixelXGlobal: number, pixelYGlobal: number): number => {
    const tileX = Math.floor(pixelXGlobal / 256);
    const tileY = Math.floor(pixelYGlobal / 256);
    const pixelX = ((pixelXGlobal % 256) + 256) % 256;
    const pixelY = ((pixelYGlobal % 256) + 256) % 256;
    const png = tileMap.get(`${tileX}/${tileY}`);
    if (!png) {
      throw new Error(`SITECHECK01 rejected: missing DEM tile ${tileX}/${tileY}.`);
    }
    return decodeTerrarium(png, pixelX, pixelY);
  };

  const z00 = read(x0, y0);
  const z10 = read(x0 + 1, y0);
  const z01 = read(x0, y0 + 1);
  const z11 = read(x0 + 1, y0 + 1);
  const z0 = z00 + (z10 - z00) * tx;
  const z1 = z01 + (z11 - z01) * tx;
  return z0 + (z1 - z0) * ty;
}

function createTerrainSampler(
  elevations: Float32Array,
): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    const clampedX = Math.max(0, Math.min(SITECHECK_SIZE - 1, x));
    const clampedY = Math.max(0, Math.min(SITECHECK_SIZE - 1, y));
    const column0 = Math.min(SITECHECK_SIZE - 2, Math.floor(clampedX));
    const sourceRow = (SITECHECK_SIZE - 1) - clampedY;
    const row0 = Math.max(
      0,
      Math.min(SITECHECK_SIZE - 2, Math.floor(sourceRow)),
    );
    const column1 = column0 + 1;
    const row1 = row0 + 1;
    const tx = clampedX - column0;
    const ty = sourceRow - row0;

    const z00 = elevations[row0 * SITECHECK_SIZE + column0];
    const z10 = elevations[row0 * SITECHECK_SIZE + column1];
    const z01 = elevations[row1 * SITECHECK_SIZE + column0];
    const z11 = elevations[row1 * SITECHECK_SIZE + column1];
    const z0 = z00 + (z10 - z00) * tx;
    const z1 = z01 + (z11 - z01) * tx;
    return z0 + (z1 - z0) * ty;
  };
}
