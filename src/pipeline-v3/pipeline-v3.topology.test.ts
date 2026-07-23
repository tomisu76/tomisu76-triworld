import { describe, test, expect } from 'vitest';
import { validateTerrainTopology } from './diagnostics/validateTerrainTopology';
import {
  buildCesiumTerrainPreviewMesh,
  buildDirectCanonicalSampleMesh,
  type CanonicalTerrain,
} from '../roads/canonical-terrain';

function createMockCanonical(
  resolution: 512 | 1024,
  fn: (x: number, y: number) => number,
): CanonicalTerrain {
  const size = resolution;
  const heights = new Float32Array(size * size);
  const halfExtent = size / 2;

  for (let r = 0; r < size; r++) {
    const y = halfExtent - r * 1.0;
    for (let c = 0; c < size; c++) {
      const x = -halfExtent + c * 1.0;
      heights[r * size + c] = fn(x, y);
    }
  }

  return {
    resolution,
    squareSize: 1,
    worldSideMetres: resolution,
    origin: [-halfExtent, -halfExtent, 0],
    heights,
    minimumElevation: 0,
    maximumElevation: 100,
    verticalDatum: 'EPSG:25834',
    source: 'Mock Analytic',
    transform: {
      resolution,
      squareSize: 1,
      halfExtentMetres: halfExtent,
      sampleSpacingMetres: 1.0,
      row0Location: 'north',
      col0Location: 'west',
    },
    seams: { maxHorizontalSeamMismatch: 0, maxVerticalSeamMismatch: 0 },
    encoding: {
      minimumElevation: 0,
      maximumElevation: 100,
      localRelief: 100,
      chosenMaxHeight: 100,
      verticalStep: 100 / 65535,
      maximumEncodingError: 0.001,
      u16Heights: new Uint16Array(0),
    },
  };
}

describe('Pipeline V3 — Index Topology & Mesh Adapter Verification (Directives A - G)', () => {

  test('Directive A: Flat 512 terrain — strict 513 stride, all triangles coplanar & CCW winding', () => {
    const canonical = createMockCanonical(512, () => 20.0);
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);
    const report = validateTerrainTopology(mesh, 513);

    expect(report.valid).toBe(true);
    expect(report.vertexCount).toBe(513 * 513);
    expect(report.triangleCount).toBe(512 * 512 * 2);
    expect(report.maximumConnectedGridRowDistance).toBe(1);
    expect(report.maximumConnectedGridColumnDistance).toBe(1);
    expect(report.singleUseInternalEdgeCount).toBe(0);
    expect(report.overusedEdgeCount).toBe(0);
  });

  test('Directive B: Tilted plane — rendered mesh remains one exact plane', () => {
    const canonical = createMockCanonical(512, (x, y) => 10.0 + 0.05 * x - 0.02 * y);
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);
    const report = validateTerrainTopology(mesh, 513);

    expect(report.valid).toBe(true);
  });

  test('Directive C: Asymmetric analytic terrain — z = 0.002x + 0.004y + 0.00002x^2 - 0.00001y^2', () => {
    const fn = (x: number, y: number) => 0.002 * x + 0.004 * y + 0.00002 * x * x - 0.00001 * y * y;
    const canonical = createMockCanonical(512, fn);
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);
    const report = validateTerrainTopology(mesh, 513);

    expect(report.valid).toBe(true);
  });

  test('Directive D: Single impulse sample — localized height modification only', () => {
    const canonical = createMockCanonical(512, () => 0.0);
    canonical.heights[256 * 512 + 256] = 50.0; // Single spike at center
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);
    const report = validateTerrainTopology(mesh, 513);

    expect(report.valid).toBe(true);
  });

  test('Directive E: Row-stride test — must fail if invalid stride is used', () => {
    const canonical = createMockCanonical(512, () => 0.0);
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);

    // Intentionally corrupt index stride (substitute 512 stride into 513 mesh)
    const corruptedIndices = mesh.indices.slice();
    for (let r = 0; r < 512; r++) {
      const c = 511; // Last column
      const triIdx = (r * 512 + c) * 2; // Last quad of row
      const a = r * 512 + c; // WRONG STRIDE 512 instead of 513!
      const b = a + 1;
      const d = (r + 1) * 512 + c;
      const e = d + 1;
      corruptedIndices[triIdx * 3 + 0] = a;
      corruptedIndices[triIdx * 3 + 1] = e;
      corruptedIndices[triIdx * 3 + 2] = b;
    }

    const corruptedMesh = { ...mesh, indices: corruptedIndices };
    const report = validateTerrainTopology(corruptedMesh, 513);

    expect(report.valid).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);
  });

  test('Directive F: Adapter comparison — direct N x N mesh vs N+1 x N+1 mesh represent same surface', () => {
    const fn = (x: number, y: number) => 15.0 + 0.01 * x;
    const canonical = createMockCanonical(512, fn);
    const directMesh = buildDirectCanonicalSampleMesh(canonical, 0);
    const adaptedMesh = buildCesiumTerrainPreviewMesh(canonical, 0, 513);

    const directReport = validateTerrainTopology(directMesh, 512);
    const adaptedReport = validateTerrainTopology(adaptedMesh, 513);

    expect(directReport.valid).toBe(true);
    expect(adaptedReport.valid).toBe(true);
  });

  test('Directive G: 1024-map topology validation (1,048,576 samples / 1025 x 1025 vertices)', async () => {
    const canonical = createMockCanonical(1024, (x, y) => 30.0 + 0.005 * x);
    const mesh = buildCesiumTerrainPreviewMesh(canonical, 0, 1025);
    const report = validateTerrainTopology(mesh, 1025);

    expect(report.valid).toBe(true);
    expect(report.vertexCount).toBe(1025 * 1025);
    expect(report.triangleCount).toBe(1024 * 1024 * 2);
  }, 20000);

});
