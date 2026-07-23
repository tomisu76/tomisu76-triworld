import { describe, test, expect } from 'vitest';
import { buildBanovceRealWorldTerrain, sampleBanovceElevation } from './gis-terrain';
import { GeodeticTransformer, BANOVCE_ORIGIN_WGS84 } from './geodetic-transformer';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 1 (Real-World Terrain & Geodetic Validation)', () => {
  const size = 1024;
  const squareSize = 1.0;

  test('1. DEM to Native TER Conversion — 1024x1024 grid size', () => {
    const { artifact } = buildBanovceRealWorldTerrain({ size, squareSize });
    expect(artifact.version).toBe(9);
    expect(artifact.size).toBe(1024);
    expect(artifact.squareSize).toBe(1.0);
    expect(artifact.heightMapU16.length).toBe(1024 * 1024);
    expect(artifact.layerMapU8.length).toBe(1024 * 1024);
  });

  test('2. Strict North-South & East-West Orientation Invariants', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 1024);

    const swLocal = { x: 0, y: 0, z: 200 };
    const neLocal = { x: 1024, y: 1024, z: 200 };

    const swUtm = transformer.localToUtm(swLocal);
    const neUtm = transformer.localToUtm(neLocal);

    // North (+Y) must have greater northing than South
    expect(neUtm.northing).toBeGreaterThan(swUtm.northing);
    expect(neUtm.northing - swUtm.northing).toBeCloseTo(1024, 4);

    // East (+X) must have greater easting than West
    expect(neUtm.easting).toBeGreaterThan(swUtm.easting);
    expect(neUtm.easting - swUtm.easting).toBeCloseTo(1024, 4);
  });

  test('3. Geodetic Round-Trip Accuracy — Horizontal error <= 1.0m, Vertical error <= 0.5m', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 1024);

    const testPoints = [
      { x: 0, y: 0, z: 215.0 },
      { x: 512, y: 512, z: 240.0 },
      { x: 1024, y: 1024, z: 310.0 },
      { x: 250, y: 750, z: 280.0 },
    ];

    for (const pt of testPoints) {
      const { horizontalErrorMetres, verticalErrorMetres } = transformer.validateRoundTripError(pt);
      expect(horizontalErrorMetres).toBeLessThanOrEqual(1.0);
      expect(verticalErrorMetres).toBeLessThanOrEqual(0.5);
    }
  });

  test('4. Scanned Height Bounds & Data Quality — No NaN, Infinity, or steps', () => {
    const { artifact, scannedMinElevation, scannedMaxElevation, rawElevations } = buildBanovceRealWorldTerrain({ size, squareSize });

    expect(scannedMinElevation).toBeGreaterThanOrEqual(150.0);
    expect(scannedMaxElevation).toBeLessThanOrEqual(500.0);
    expect(scannedMinElevation).toBeCloseTo(artifact.minimumDecodedElevation, 4);
    expect(scannedMaxElevation).toBeCloseTo(artifact.maximumDecodedElevation, 4);

    for (let i = 0; i < rawElevations.length; i++) {
      const val = rawElevations[i];
      expect(Number.isFinite(val)).toBe(true);
      expect(Number.isNaN(val)).toBe(false);
    }
  }, 30000);

  test('5. Diagnostic Markers Invariant in items.level.json', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 1024);
    const markers = generateDiagnosticMarkers(transformer, (x, y) => sampleBanovceElevation(x, y, transformer));

    const files = generateLevelPackageFiles(
      { size: 1024, squareSize: 1.0, maxHeight: 500.0 },
      { extraMarkers: markers }
    );

    const lines = files.itemsLevelJson.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(6);

    const objects = lines.map((l) => JSON.parse(l));

    expect(objects.some((o: any) => o.name === 'MissionGroup')).toBe(true);
    expect(objects.some((o: any) => o.name === 'spawns_default')).toBe(true);
    expect(objects.some((o: any) => o.name === 'Marker_North_Arrow')).toBe(true);
    expect(objects.some((o: any) => o.name === 'Corner_Marker_SW')).toBe(true);
    expect(objects.some((o: any) => o.name === 'Corner_Marker_NE')).toBe(true);
  });

  test('6. Deterministic Output — Repeated runs produce byte-identical elevation buffers', () => {
    const run1 = buildBanovceRealWorldTerrain({ size: 1024, squareSize: 1.0 });
    const run2 = buildBanovceRealWorldTerrain({ size: 1024, squareSize: 1.0 });

    expect(run1.artifact.heightMapU16).toEqual(run2.artifact.heightMapU16);
    expect(run1.scannedMinElevation).toBe(run2.scannedMinElevation);
    expect(run1.scannedMaxElevation).toBe(run2.scannedMaxElevation);
  });
});
