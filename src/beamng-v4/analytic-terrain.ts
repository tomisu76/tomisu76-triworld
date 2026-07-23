import type { AnalyticTerrainResult, BeamNGTerrainArtifact } from './types';

export function generateAnalyticGate0Terrain(
  size: number = 512,
  squareSize: number = 1.0,
  maxHeight: number = 100.0,
  terrainPosition: [number, number, number] = [0, 0, 0],
): { result: AnalyticTerrainResult; artifact: BeamNGTerrainArtifact } {
  const sampleCount = size * size;
  const heightsFloat32 = new Float32Array(sampleCount);
  const heightMapU16 = new Uint16Array(sampleCount);
  const layerMapU8 = new Uint8Array(sampleCount); // All 0s for triworld_v4_ground

  const heightScale = maxHeight / 65536.0;

  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < size; r++) {
    const y = r; // integer sample coordinate 0..511
    for (let c = 0; c < size; c++) {
      const x = c; // integer sample coordinate 0..511

      const unquantizedZ = 10.0 + 0.01 * x + 0.02 * y + 0.0001 * x * x;
      if (!Number.isFinite(unquantizedZ) || unquantizedZ < 0 || unquantizedZ > maxHeight) {
        throw new Error(`Elevation at (${x}, ${y}) is out of bounds: ${unquantizedZ}`);
      }

      const idx = r * size + c;
      heightsFloat32[idx] = unquantizedZ;
      minZ = Math.min(minZ, unquantizedZ);
      maxZ = Math.max(maxZ, unquantizedZ);

      // Quantization
      const encoded = Math.min(65535, Math.max(0, Math.round(unquantizedZ / heightScale)));
      heightMapU16[idx] = encoded;
    }
  }

  let minDecodedZ = Number.POSITIVE_INFINITY;
  let maxDecodedZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sampleCount; i++) {
    const decoded = terrainPosition[2] + heightMapU16[i] * heightScale;
    minDecodedZ = Math.min(minDecodedZ, decoded);
    maxDecodedZ = Math.max(maxDecodedZ, decoded);
  }

  function getControlPoint(c: number, r: number) {
    const idx = r * size + c;
    const unquantized = heightsFloat32[idx];
    const decoded = terrainPosition[2] + heightMapU16[idx] * heightScale;
    return { unquantized, decoded };
  }

  const controlPoints = {
    p0_0: getControlPoint(0, 0),
    p511_0: getControlPoint(511, 0),
    p0_511: getControlPoint(0, 511),
    p511_511: getControlPoint(511, 511),
    p256_256: getControlPoint(256, 256),
  };

  const result: AnalyticTerrainResult = {
    size,
    squareSize,
    maxHeight,
    heightScale,
    terrainPosition,
    heightsFloat32,
    heightMapU16,
    controlPoints,
    minElevation: minDecodedZ,
    maxElevation: maxDecodedZ,
  };

  const artifact: BeamNGTerrainArtifact = {
    version: 9,
    size,
    heightMapU16,
    layerMapU8,
    materialNames: ['triworld_v4_ground'],
  };

  return { result, artifact };
}
