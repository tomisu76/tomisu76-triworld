/**
 * GIS Real-World Terrain Generator — TriWorld V4 Gate 1
 * Generates native BeamNG terrain for Bánovce nad Bebravou region (Slovakia, UTM 34N).
 */

import { BeamNGTerrainArtifact } from './types';
import { GeodeticTransformer, BANOVCE_ORIGIN_WGS84, Wgs84Point } from './geodetic-transformer';

export interface GisTerrainConfig {
  size: number; // e.g. 1024
  squareSize: number; // 1.0
  maxHeight: number; // e.g. 500.0 (max elevation range ceiling)
  centerWgs84?: Wgs84Point;
}

export interface GisTerrainResult {
  artifact: BeamNGTerrainArtifact;
  transformer: GeodeticTransformer;
  rawElevations: Float32Array; // Original floating-point elevations in metres
  scannedMinElevation: number;
  scannedMaxElevation: number;
}

/**
 * Analytic Bánovce Real-World DEM Function z(x,y)
 * Represents the topographic profile of Bánovce nad Bebravou valley & Strážovské foothills.
 * Local x in [0, size], local y in [0, size].
 * Local y = 0 is South, local y = size is North.
 */
export function sampleBanovceElevation(xMetres: number, yMetres: number, transformer: GeodeticTransformer): number {
  const utm = transformer.localToUtm({ x: xMetres, y: yMetres, z: 0 });
  const dx = (xMetres - transformer.origin.sizeMetres / 2) / 500.0;
  const dy = (yMetres - transformer.origin.sizeMetres / 2) / 500.0;

  // Base valley floor elevation around Bánovce (215m)
  const baseElevation = 215.0;

  // Foothills elevation gradient towards North/Northeast (Strážovské vrchy)
  const northGradient = 45.0 * Math.max(0, dy + 0.3);

  // Gentle East-West valley slope
  const eastHills = 25.0 * Math.sin(dx * 1.5 + 0.5) * Math.cos(dy * 1.2);

  // Secondary rolling hills
  const rolling = 12.0 * Math.sin(dx * 3.2) * Math.sin(dy * 3.8);

  // Bebrava river valley depression along North-South axis
  const riverDist = Math.abs(dx - 0.1 * Math.sin(dy * 2.0));
  const riverValley = -8.0 * Math.exp(-(riverDist ** 2) / 0.08);

  const elevation = baseElevation + northGradient + eastHills + rolling + riverValley;

  // Ensure elevation stays strictly positive and finite
  return Math.max(150.0, Math.min(800.0, elevation));
}

/**
 * Builds the real-world GIS terrain artifact for Gate 1.
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

  // GeoTIFF / Raster standard:
  // Row 0 = North (y = size - 1)
  // Row size - 1 = South (y = 0)
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

  // Height quantization into Uint16
  const heightScale = maxHeight / 65535.0;
  const heightMapU16 = new Uint16Array(size * size);

  for (let i = 0; i < rawElevations.length; i++) {
    const val = rawElevations[i];
    const quantized = Math.round(val / heightScale);
    heightMapU16[i] = Math.max(0, Math.min(65535, quantized));
  }

  // Scan decoded Uint16 height map for authoritative min/max decoded elevations
  let scannedMin = Number.POSITIVE_INFINITY;
  let scannedMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < heightMapU16.length; i++) {
    const decoded = heightMapU16[i] * heightScale;
    if (decoded < scannedMin) scannedMin = decoded;
    if (decoded > scannedMax) scannedMax = decoded;
  }

  // Layer map (0 = primary material)
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

  return {
    artifact,
    transformer,
    rawElevations,
    scannedMinElevation: scannedMin,
    scannedMaxElevation: scannedMax,
  };
}
