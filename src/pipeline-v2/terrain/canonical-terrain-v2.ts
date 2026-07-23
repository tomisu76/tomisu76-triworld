import {
  createTerrainGridTransformV2,
  gridColumnToLocalX,
  gridRowToLocalY,
  type BeamNgPresetV2,
  type TerrainGridTransformV2,
} from './terrain-grid-transform';

export interface CanonicalTerrainV2 {
  resolution: BeamNgPresetV2;
  squareSize: 1;
  transform: TerrainGridTransformV2;
  sourceHeights: Float32Array;
  workingHeights: Float32Array;
}

export function createCanonicalTerrainV2(
  resolution: BeamNgPresetV2,
  sampleElevation: (xMetres: number, yMetres: number) => number,
): CanonicalTerrainV2 {
  const transform = createTerrainGridTransformV2(resolution);
  const count = resolution * resolution;
  const sourceHeights = new Float32Array(count);
  const workingHeights = new Float32Array(count);

  for (let r = 0; r < resolution; r++) {
    const y = gridRowToLocalY(transform, r);
    for (let c = 0; c < resolution; c++) {
      const x = gridColumnToLocalX(transform, c);
      const z = sampleElevation(x, y);
      const idx = r * resolution + c;
      sourceHeights[idx] = z;
      workingHeights[idx] = z;
    }
  }

  return {
    resolution,
    squareSize: 1,
    transform,
    sourceHeights,
    workingHeights,
  };
}
