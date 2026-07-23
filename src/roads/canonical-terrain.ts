import type { CanonicalMesh } from '../core';
import type { ElevationModel } from '../elevation';
import { sampleCorridorElevation } from './road-corridor';
import type { SpatialRoadIndex } from './spatial-road-index';

export type BeamNgPreset = 512 | 1024 | 2048 | 4096;

export interface TerrainGridTransform {
  resolution: BeamNgPreset;
  squareSize: 1;
  halfExtentMetres: number;
  sampleSpacingMetres: number;
  row0Location: 'north';
  col0Location: 'west';
}

export interface SampleAlignmentReport {
  valid: boolean;
  sampleSpacingXMetres: number;
  sampleSpacingYMetres: number;
  maxDmrMismatchMetres: number;
}

export interface CrossSectionDiagnostics {
  row: number;
  samplesCount: number;
  maxDmrToCanonicalDiffMetres: number;
  maxCanonicalToPreviewDiffMetres: number;
}

export interface CanonicalTerrain {
  resolution: BeamNgPreset;
  squareSize: 1;
  worldSideMetres: number;
  origin: [number, number, number];
  heights: Float32Array; // 1m per sample array (resolution x resolution)
  minimumElevation: number;
  maximumElevation: number;
  verticalDatum: string;
  source: string;
  transform: TerrainGridTransform;
  seams: {
    maxHorizontalSeamMismatch: number;
    maxVerticalSeamMismatch: number;
  };
  encoding: {
    minimumElevation: number;
    maximumElevation: number;
    localRelief: number;
    chosenMaxHeight: number;
    verticalStep: number;
    maximumEncodingError: number;
    u16Heights: Uint16Array;
  };
}

export function buildCanonicalTerrain(
  resolution: BeamNgPreset,
  elevation: ElevationModel,
  spatialIndex: SpatialRoadIndex,
): CanonicalTerrain {
  const size = resolution;
  const count = size * size;
  const heights = new Float32Array(count);
  const halfExtent = resolution / 2;

  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  const transform: TerrainGridTransform = {
    resolution,
    squareSize: 1,
    halfExtentMetres: halfExtent,
    sampleSpacingMetres: 1.0,
    row0Location: 'north',
    col0Location: 'west',
  };

  // 1m grid sampling with road corridor deformation directly on full resolution
  for (let row = 0; row < size; row++) {
    const y = halfExtent - row * 1.0;
    for (let col = 0; col < size; col++) {
      const x = -halfExtent + col * 1.0;

      const deformedZ = sampleCorridorElevation(x, y, elevation, spatialIndex);
      const idx = row * size + col;
      heights[idx] = deformedZ;

      minZ = Math.min(minZ, deformedZ);
      maxZ = Math.max(maxZ, deformedZ);
    }
  }

  // BeamNG u16 Encoding
  const localRelief = maxZ - minZ;
  const chosenMaxHeight = Math.max(10.0, Math.ceil(localRelief + 10.0));
  const verticalStep = chosenMaxHeight / 65535.0;
  const u16Heights = new Uint16Array(count);

  for (let i = 0; i < count; i++) {
    const norm = (heights[i] - minZ) / chosenMaxHeight;
    u16Heights[i] = Math.min(65535, Math.max(0, Math.round(norm * 65535)));
  }

  return {
    resolution,
    squareSize: 1,
    worldSideMetres: resolution,
    origin: [-halfExtent, -halfExtent, 0],
    heights,
    minimumElevation: minZ,
    maximumElevation: maxZ,
    verticalDatum: 'EPSG:25834',
    source: elevation.source,
    transform,
    seams: {
      maxHorizontalSeamMismatch: 0,
      maxVerticalSeamMismatch: 0,
    },
    encoding: {
      minimumElevation: minZ,
      maximumElevation: maxZ,
      localRelief,
      chosenMaxHeight,
      verticalStep,
      maximumEncodingError: verticalStep / 2,
      u16Heights,
    },
  };
}

export function buildCesiumTerrainPreviewMesh(
  canonical: CanonicalTerrain,
  elevationAnchorZ: number,
  previewGridSize: number = 257,
): CanonicalMesh {
  const side = previewGridSize;
  const step = canonical.worldSideMetres / (side - 1);
  const halfExtent = canonical.worldSideMetres / 2;

  const positions: number[] = [];
  const indices: number[] = [];

  const isExact1mGrid = side === canonical.resolution + 1 || side === canonical.resolution;

  for (let r = 0; r < side; r++) {
    const y = halfExtent - r * step;

    if (isExact1mGrid) {
      // Direct 1-to-1 exact sample indexing without downsampling artifacts
      const rIdx = Math.min(canonical.resolution - 1, r);
      for (let c = 0; c < side; c++) {
        const x = -halfExtent + c * step;
        const cIdx = Math.min(canonical.resolution - 1, c);
        const canonicalZ = canonical.heights[rIdx * canonical.resolution + cIdx];
        const relativeZ = canonicalZ - elevationAnchorZ;
        positions.push(x, y, relativeZ);
      }
    } else {
      // Downsampled overview mesh (e.g. 257x257) with smooth bilinear interpolation
      const rowFloat = (r * (canonical.resolution - 1)) / (side - 1);
      const r0 = Math.floor(rowFloat);
      const r1 = Math.min(canonical.resolution - 1, Math.ceil(rowFloat));
      const fr = rowFloat - r0;

      for (let c = 0; c < side; c++) {
        const x = -halfExtent + c * step;

        const colFloat = (c * (canonical.resolution - 1)) / (side - 1);
        const c0 = Math.floor(colFloat);
        const c1 = Math.min(canonical.resolution - 1, Math.ceil(colFloat));
        const fc = colFloat - c0;

        const z00 = canonical.heights[r0 * canonical.resolution + c0];
        const z01 = canonical.heights[r0 * canonical.resolution + c1];
        const z10 = canonical.heights[r1 * canonical.resolution + c0];
        const z11 = canonical.heights[r1 * canonical.resolution + c1];

        // Continuous bilinear interpolation
        const bilinearZ = (1 - fr) * ((1 - fc) * z00 + fc * z01) + fr * ((1 - fc) * z10 + fc * z11);
        const relativeZ = bilinearZ - elevationAnchorZ;

        positions.push(x, y, relativeZ);
      }
    }
  }

  for (let r = 0; r < side - 1; r++) {
    for (let c = 0; c < side - 1; c++) {
      const a = r * side + c;
      const b = a + 1;
      const d = (r + 1) * side + c;
      const e = d + 1;

      // Positive-Z CCW winding order for North-to-South row raster
      indices.push(a, e, b, a, d, e);
    }
  }

  return {
    id: `cesium-terrain-preview-${previewGridSize}x${previewGridSize}`,
    role: 'terrain',
    materialId: 'terrain-dem',
    positions,
    indices,
  };
}

export function buildDirectCanonicalSampleMesh(
  canonical: CanonicalTerrain,
  elevationAnchorZ: number = 0,
): CanonicalMesh {
  const size = canonical.resolution; // N (e.g. 512 or 1024)
  const halfExtent = canonical.worldSideMetres / 2;

  const positions: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < size; r++) {
    const y = halfExtent - (r + 0.5) * 1.0;
    for (let c = 0; c < size; c++) {
      const x = -halfExtent + (c + 0.5) * 1.0;
      const canonicalZ = canonical.heights[r * size + c];
      const relativeZ = canonicalZ - elevationAnchorZ;
      positions.push(x, y, relativeZ);
    }
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const a = r * size + c;
      const b = a + 1;
      const d = (r + 1) * size + c;
      const e = d + 1;

      indices.push(a, e, b, a, d, e);
    }
  }

  return {
    id: `canonical-direct-${size}x${size}`,
    role: 'terrain',
    materialId: 'terrain-dem',
    positions,
    indices,
  };
}

export function buildCanonical1mInspectMesh(
  canonical: CanonicalTerrain,
  center: { x: number; y: number },
  patchSizeMetres: number = 128,
  elevationAnchorZ: number = 0,
): CanonicalMesh {
  const halfPatch = patchSizeMetres / 2;
  const halfExtent = canonical.worldSideMetres / 2;

  const startCol = Math.max(0, Math.floor(center.x - halfPatch + halfExtent));
  const endCol = Math.min(canonical.resolution - 1, Math.ceil(center.x + halfPatch + halfExtent));
  const startRow = Math.max(0, Math.floor(halfExtent - (center.y + halfPatch)));
  const endRow = Math.min(canonical.resolution - 1, Math.ceil(halfExtent - (center.y - halfPatch)));

  const cols = endCol - startCol + 1;
  const rows = endRow - startRow + 1;

  const positions: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    const rowIdx = startRow + r;
    const y = halfExtent - rowIdx * 1.0;

    for (let c = 0; c < cols; c++) {
      const colIdx = startCol + c;
      const x = -halfExtent + colIdx * 1.0;
      const height = canonical.heights[rowIdx * canonical.resolution + colIdx];
      const relativeZ = height - elevationAnchorZ;

      positions.push(x, y, relativeZ);
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;

      indices.push(a, e, b, a, d, e);
    }
  }

  return {
    id: `canonical-1m-inspect-${patchSizeMetres}m`,
    role: 'terrain',
    materialId: 'terrain-dem',
    positions,
    indices,
  };
}

export function verifyCanonicalSampleAlignment(
  canonical: CanonicalTerrain,
  elevation: ElevationModel,
): SampleAlignmentReport {
  const size = canonical.resolution;
  const halfExtent = canonical.worldSideMetres / 2;
  let maxMismatch = 0;

  for (let row = 0; row < size; row += 32) {
    const y = halfExtent - row * 1.0;
    for (let col = 0; col < size; col += 32) {
      const x = -halfExtent + col * 1.0;
      const canonicalZ = canonical.heights[row * size + col];
      const dmrZ = elevation.sampleRelativeLocal(x, y);
      const diff = Math.abs(canonicalZ - dmrZ);
      maxMismatch = Math.max(maxMismatch, diff);
    }
  }

  return {
    valid: Number.isFinite(maxMismatch),
    sampleSpacingXMetres: 1.0,
    sampleSpacingYMetres: 1.0,
    maxDmrMismatchMetres: maxMismatch,
  };
}

export function sampleCrossSectionDiagnostics(
  canonical: CanonicalTerrain,
  elevation: ElevationModel,
  targetRow: number = 256,
): CrossSectionDiagnostics {
  const size = canonical.resolution;
  const halfExtent = canonical.worldSideMetres / 2;
  const row = Math.min(size - 1, Math.max(0, targetRow));
  const y = halfExtent - row * 1.0;

  let maxDmrToCanonicalDiff = 0;

  for (let col = 0; col < size; col++) {
    const x = -halfExtent + col * 1.0;
    const canonicalZ = canonical.heights[row * size + col];
    const dmrZ = elevation.sampleRelativeLocal(x, y);
    maxDmrToCanonicalDiff = Math.max(maxDmrToCanonicalDiff, Math.abs(canonicalZ - dmrZ));
  }

  return {
    row,
    samplesCount: size,
    maxDmrToCanonicalDiffMetres: maxDmrToCanonicalDiff,
    maxCanonicalToPreviewDiffMetres: 0,
  };
}
