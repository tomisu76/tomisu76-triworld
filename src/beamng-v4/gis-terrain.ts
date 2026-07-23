/**
 * GIS Real-World Terrain Generator — TriWorld V4 Gate 1 & Gate 2 & Gate 3
 * Generates native BeamNG terrain for Bánovce nad Bebravou region using real global DEM raster data
 * (Copernicus / AWS Terrarium 30m DEM elevation tiles) with smooth 2D bilinear interpolation
 * and coupled 3D road corridor formation bed flattening (Gate 3).
 */

import { PNG } from 'pngjs';
import { BeamNGTerrainArtifact } from './types';
import { GeodeticTransformer, BANOVCE_ORIGIN_WGS84, Wgs84Point } from './geodetic-transformer';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';

export interface GisTerrainConfig {
  size: number; // e.g. 1024
  squareSize: number; // 1.0
  maxHeight: number; // e.g. 500.0 (max elevation range ceiling)
  centerWgs84?: Wgs84Point;
  useRealDem?: boolean;
  withRoadCorridor?: boolean;
}

export interface GisTerrainResult {
  artifact: BeamNGTerrainArtifact;
  transformer: GeodeticTransformer;
  rawElevations: Float32Array; // Original floating-point elevations in metres
  scannedMinElevation: number;
  scannedMaxElevation: number;
  isRealDem: boolean;
  hasRoadCorridor: boolean;
  corridorPriorityBuffer?: Uint8Array;
  sampleElevation: (xMetres: number, yMetres: number) => number;
}

/**
 * Converts (lon, lat, zoom) to Terrarium Web Mercator tile (X, Y) and sub-pixel (fx, fy).
 */
export function wgs84ToTileCoords(lon: number, lat: number, zoom: number = 14): { tileX: number; tileY: number; fx: number; fy: number } {
  const n = Math.pow(2, zoom);
  const radLat = (lat * Math.PI) / 180;

  const xVal = ((lon + 180) / 360) * n;
  const yVal = ((1 - Math.log(Math.tan(radLat) + 1 / Math.cos(radLat)) / Math.PI) / 2) * n;

  const tileX = Math.floor(xVal);
  const tileY = Math.floor(yVal);
  const fx = xVal - tileX;
  const fy = yVal - tileY;

  return { tileX, tileY, fx, fy };
}

/**
 * Decodes Terrarium PNG pixel (R, G, B) into elevation in metres.
 * Formula: Z = (R * 256 + G + B / 256) - 32768
 */
export function decodeTerrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Fetches and decodes AWS Terrarium DEM tiles for Bánovce region.
 */
export async function loadTerrariumDemTiles(tileCoordsList: Array<{ tileX: number; tileY: number }>, zoom: number = 14): Promise<Map<string, PNG>> {
  const tileMap = new Map<string, PNG>();

  for (const { tileX, tileY } of tileCoordsList) {
    const key = `${tileX}_${tileY}`;
    if (tileMap.has(key)) continue;

    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tileX}/${tileY}.png`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const png = PNG.sync.read(buffer);
        tileMap.set(key, png);
      }
    } catch (e) {
      console.warn(`Could not load Terrarium DEM tile ${zoom}/${tileX}/${tileY}:`, e);
    }
  }

  return tileMap;
}

/**
 * Samples elevation with 2D Bilinear Interpolation across 4 surrounding DEM pixels.
 * Eliminates voxel / Minecraft terraced steps!
 */
export function sampleLoadedDemElevation(lon: number, lat: number, tileMap: Map<string, PNG>, zoom: number = 14): number | null {
  const { tileX, tileY, fx, fy } = wgs84ToTileCoords(lon, lat, zoom);
  const key = `${tileX}_${tileY}`;
  const png = tileMap.get(key);
  if (!png) return null;

  const gx = fx * 256 - 0.5;
  const gy = fy * 256 - 0.5;

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const rx = gx - x0;
  const ry = gy - y0;

  const getPixelElev = (px: number, py: number): number => {
    let tX = tileX;
    let tY = tileY;
    let pX = px;
    let pY = py;

    if (pX < 0) { tX--; pX += 256; }
    if (pX >= 256) { tX++; pX -= 256; }
    if (pY < 0) { tY--; pY += 256; }
    if (pY >= 256) { tY++; pY -= 256; }

    const targetPng = tileMap.get(`${tX}_${tY}`) ?? png;
    const clampedX = Math.min(255, Math.max(0, pX));
    const clampedY = Math.min(255, Math.max(0, pY));
    const idx = (clampedY * 256 + clampedX) * 4;
    return decodeTerrariumElevation(targetPng.data[idx], targetPng.data[idx + 1], targetPng.data[idx + 2]);
  };

  const e00 = getPixelElev(x0, y0);
  const e10 = getPixelElev(x1, y0);
  const e01 = getPixelElev(x0, y1);
  const e11 = getPixelElev(x1, y1);

  const e0 = e00 * (1 - rx) + e10 * rx;
  const e1 = e01 * (1 - rx) + e11 * rx;
  return e0 * (1 - ry) + e1 * ry;
}

/**
 * Fallback analytic elevation profile for Bánovce nad Bebravou valley.
 */
export function sampleBanovceElevation(xMetres: number, yMetres: number, transformer: GeodeticTransformer): number {
  const dx = (xMetres - transformer.origin.sizeMetres / 2) / 500.0;
  const dy = (yMetres - transformer.origin.sizeMetres / 2) / 500.0;

  const baseElevation = 215.0;
  const northGradient = 45.0 * Math.max(0, dy + 0.3);
  const eastHills = 25.0 * Math.sin(dx * 1.5 + 0.5) * Math.cos(dy * 1.2);
  const rolling = 12.0 * Math.sin(dx * 3.2) * Math.sin(dy * 3.8);

  const riverDist = Math.abs(dx - 0.1 * Math.sin(dy * 2.0));
  const riverValley = -8.0 * Math.exp(-(riverDist ** 2) / 0.08);

  const elevation = baseElevation + northGradient + eastHills + rolling + riverValley;
  return Math.max(150.0, Math.min(800.0, elevation));
}

/**
 * Synchronous build method using cached / pre-loaded or fallback DEM.
 */
export function buildBanovceRealWorldTerrain(config: Partial<GisTerrainConfig> = {}): GisTerrainResult {
  const size = config.size ?? 1024;
  const squareSize = config.squareSize ?? 1.0;
  const maxHeight = config.maxHeight ?? 500.0;
  const centerWgs84 = config.centerWgs84 ?? BANOVCE_ORIGIN_WGS84;

  const transformer = new GeodeticTransformer(centerWgs84, size * squareSize);
  const rawElevations = new Float32Array(size * size);

  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < size; r++) {
    const yMetres = (size - 1 - r) * squareSize;
    for (let c = 0; c < size; c++) {
      const xMetres = c * squareSize;
      const z = sampleBanovceElevation(xMetres, yMetres, transformer);
      rawElevations[r * size + c] = z;
      if (z < rawMin) rawMin = z;
      if (z > rawMax) rawMax = z;
    }
  }

  const heightScale = maxHeight / 65535.0;
  const heightMapU16 = new Uint16Array(size * size);

  for (let i = 0; i < rawElevations.length; i++) {
    const val = rawElevations[i];
    const quantized = Math.round(val / heightScale);
    heightMapU16[i] = Math.max(0, Math.min(65535, quantized));
  }

  let scannedMin = Number.POSITIVE_INFINITY;
  let scannedMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < heightMapU16.length; i++) {
    const decoded = heightMapU16[i] * heightScale;
    if (decoded < scannedMin) scannedMin = decoded;
    if (decoded > scannedMax) scannedMax = decoded;
  }

  const layerMapU8 = new Uint8Array(size * size);

  const artifact: BeamNGTerrainArtifact = {
    version: 9,
    size,
    squareSize,
    maxHeight,
    heightScale,
    minimumDecodedElevation: scannedMin,
    maximumDecodedElevation: scannedMax,
    heightMapU16,
    layerMapU8,
    materialNames: ['triworld_v4_ground'],
  };

  const sampleElevation = (xMetres: number, yMetres: number): number => {
    const c = Math.max(0, Math.min(size - 1, Math.round(xMetres / squareSize)));
    const r = Math.max(0, Math.min(size - 1, Math.round((size - 1 - yMetres / squareSize))));
    return rawElevations[r * size + c];
  };

  return {
    artifact,
    transformer,
    rawElevations,
    scannedMinElevation: scannedMin,
    scannedMaxElevation: scannedMax,
    isRealDem: false,
    hasRoadCorridor: false,
    sampleElevation,
  };
}

/**
 * Async build method that fetches REAL Copernicus DEM 30m tiles for Bánovce nad Bebravou!
 */
export async function buildBanovceRealWorldTerrainAsync(config: Partial<GisTerrainConfig> = {}): Promise<GisTerrainResult> {
  const size = config.size ?? 1024;
  const squareSize = config.squareSize ?? 1.0;
  const maxHeight = config.maxHeight ?? 500.0;
  const centerWgs84 = config.centerWgs84 ?? BANOVCE_ORIGIN_WGS84;
  const withRoadCorridor = config.withRoadCorridor ?? true; // Default to including road corridor in Gate 3

  const transformer = new GeodeticTransformer(centerWgs84, size * squareSize);
  const zoom = 14;

  const corners = [
    { x: 0, y: 0 },
    { x: size * squareSize, y: 0 },
    { x: 0, y: size * squareSize },
    { x: size * squareSize, y: size * squareSize },
  ];

  const neededTiles: Array<{ tileX: number; tileY: number }> = [];
  for (const corner of corners) {
    const wgs = transformer.localToWgs84({ ...corner, z: 0 });
    const { tileX, tileY } = wgs84ToTileCoords(wgs.longitude, wgs.latitude, zoom);
    neededTiles.push({ tileX, tileY });
    neededTiles.push({ tileX: tileX - 1, tileY });
    neededTiles.push({ tileX: tileX + 1, tileY });
    neededTiles.push({ tileX, tileY: tileY - 1 });
    neededTiles.push({ tileX, tileY: tileY + 1 });
  }

  const tileMap = await loadTerrariumDemTiles(neededTiles, zoom);
  const isRealDem = tileMap.size > 0;

  const rawElevations = new Float32Array(size * size);

  for (let r = 0; r < size; r++) {
    const yMetres = (size - 1 - r) * squareSize;
    for (let c = 0; c < size; c++) {
      const xMetres = c * squareSize;
      const wgs = transformer.localToWgs84({ x: xMetres, y: yMetres, z: 0 });
      let z: number | null = null;
      if (isRealDem) {
        z = sampleLoadedDemElevation(wgs.longitude, wgs.latitude, tileMap, zoom);
      }
      if (z === null || isNaN(z)) {
        z = sampleBanovceElevation(xMetres, yMetres, transformer);
      }

      rawElevations[r * size + c] = z;
    }
  }

  let heightMapU16: Uint16Array;
  let finalElevations = rawElevations;
  let corridorPriorityBuffer: Uint8Array | undefined = undefined;

  if (withRoadCorridor) {
    const corridorResult = applyCoupledRoadTerrainCorridor(rawElevations, size, squareSize, maxHeight);
    finalElevations = corridorResult.workingElevations;
    heightMapU16 = corridorResult.heightMapU16;
    corridorPriorityBuffer = corridorResult.priorityBuffer;
  } else {
    const heightScale = maxHeight / 65535.0;
    heightMapU16 = new Uint16Array(size * size);
    for (let i = 0; i < rawElevations.length; i++) {
      const val = rawElevations[i];
      const quantized = Math.round(val / heightScale);
      heightMapU16[i] = Math.max(0, Math.min(65535, quantized));
    }
  }

  const heightScale = maxHeight / 65535.0;
  let scannedMin = Number.POSITIVE_INFINITY;
  let scannedMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < heightMapU16.length; i++) {
    const decoded = heightMapU16[i] * heightScale;
    if (decoded < scannedMin) scannedMin = decoded;
    if (decoded > scannedMax) scannedMax = decoded;
  }

  const layerMapU8 = new Uint8Array(size * size);

  const artifact: BeamNGTerrainArtifact = {
    version: 9,
    size,
    squareSize,
    maxHeight,
    heightScale,
    minimumDecodedElevation: scannedMin,
    maximumDecodedElevation: scannedMax,
    heightMapU16,
    layerMapU8,
    materialNames: ['triworld_v4_ground'],
  };

  const sampleElevation = (xMetres: number, yMetres: number): number => {
    const c = Math.max(0, Math.min(size - 1, Math.round(xMetres / squareSize)));
    const r = Math.max(0, Math.min(size - 1, Math.round((size - 1 - yMetres / squareSize))));
    return finalElevations[r * size + c];
  };

  return {
    artifact,
    transformer,
    rawElevations: finalElevations,
    scannedMinElevation: scannedMin,
    scannedMaxElevation: scannedMax,
    isRealDem,
    hasRoadCorridor: withRoadCorridor,
    corridorPriorityBuffer,
    sampleElevation,
  };
}
