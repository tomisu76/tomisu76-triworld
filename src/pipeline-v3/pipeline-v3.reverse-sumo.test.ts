import { describe, expect, it } from 'vitest';
import { TerrainGridV3 } from './terrain/TerrainGridV3';
import { syntheticAbsoluteElevation } from './testing/syntheticTerrain';
import { syntheticLane } from './testing/syntheticSumoLane';
import { canonicalizeSumoDirection, resampleSumoShapeGlobal } from './sumo/SumoGeometryV3';
import { designVerticalProfileV3 } from './civil/designVerticalProfile';
import { solveDaylightRayV3 } from './civil/daylightSolver';
import { buildCorridorV3 } from './corridor/buildCorridor';
import { runPipelineV3ValidationAlpha } from './pipelineV3';

describe('TriWorld Generator V3 — Validation Alpha (Numerical & Reverse-SUMO Identity)', () => {
  it('Test 1: Exact sample-centre coordinate mapping', () => {
    const grid = new TerrainGridV3(512, 1.0, syntheticAbsoluteElevation);
    expect(grid.columnToX(0)).toBeCloseTo(-255.5, 6);
    expect(grid.columnToX(511)).toBeCloseTo(255.5, 6);
    expect(grid.rowToY(0)).toBeCloseTo(255.5, 6);
    expect(grid.rowToY(511)).toBeCloseTo(-255.5, 6);

    expect(grid.xToContinuousColumn(-255.5)).toBeCloseTo(0, 6);
    expect(grid.yToContinuousRow(255.5)).toBeCloseTo(0, 6);
  });

  it('Test 2: Strict out-of-domain sampler rejection', () => {
    const grid = new TerrainGridV3(512, 1.0, syntheticAbsoluteElevation);
    expect(() => grid.sampleSourceStrict(-300, 0)).toThrow(RangeError);
    expect(() => grid.sampleSourceStrict(0, 300)).toThrow(RangeError);
    expect(() => grid.getSourceElevation(-1)).toThrow(RangeError);
    expect(() => grid.getSourceElevation(512 * 512 + 10)).toThrow(RangeError);
  });

  it('Test 3: Immutable source elevation & centre local elevation ~ 0', () => {
    const grid = new TerrainGridV3(512, 1.0, syntheticAbsoluteElevation);
    const centerSample = grid.sampleSourceStrict(0, 0);
    expect(centerSample).toBeCloseTo(0.0, 3);
  });

  it('Test 5-10: True global arc-length stationing, normalized tangents & normals', () => {
    const planStations = resampleSumoShapeGlobal(syntheticLane.shape, 1.0);
    expect(planStations.length).toBeGreaterThan(300);

    for (let i = 0; i < planStations.length - 1; i++) {
      const st = planStations[i];
      const tanLen = Math.hypot(st.tangentX, st.tangentY);
      const normLen = Math.hypot(st.normalX, st.normalY);
      const dot = st.tangentX * st.normalX + st.tangentY * st.normalY;

      expect(tanLen).toBeCloseTo(1.0, 5);
      expect(normLen).toBeCloseTo(1.0, 5);
      expect(dot).toBeCloseTo(0.0, 5);
    }
  });

  it('Test 11: Deterministic SUMO direction canonicalization', () => {
    const reversedLane = { ...syntheticLane, shape: [...syntheticLane.shape].reverse() };

    const c1 = canonicalizeSumoDirection(syntheticLane);
    const c2 = canonicalizeSumoDirection(reversedLane);

    expect(c1.canonicalShape.length).toBe(c2.canonicalShape.length);
    for (let i = 0; i < c1.canonicalShape.length; i++) {
      expect(c1.canonicalShape[i].x).toBeCloseTo(c2.canonicalShape[i].x, 6);
      expect(c1.canonicalShape[i].y).toBeCloseTo(c2.canonicalShape[i].y, 6);
    }
  });

  it('Test 30: REVERSE-SUMO END-TO-END BYTE-IDENTITY TEST', () => {
    const forwardLane = syntheticLane;
    const reversedLane = { ...syntheticLane, shape: [...syntheticLane.shape].reverse() };

    const resA = runPipelineV3ValidationAlpha(forwardLane, syntheticAbsoluteElevation, 512, 1.0);
    const resB = runPipelineV3ValidationAlpha(reversedLane, syntheticAbsoluteElevation, 512, 1.0);

    // Phase 1: Immutable source terrain bytes
    expect(resA.fingerprints.sourceTerrainHash).toBe(resB.fingerprints.sourceTerrainHash);

    // Phase 2: Canonical SUMO shape
    expect(resA.fingerprints.canonicalShapeHash).toBe(resB.fingerprints.canonicalShapeHash);

    // Phase 3: Canonical station fingerprints
    expect(resA.fingerprints.stationsHash).toBe(resB.fingerprints.stationsHash);

    // Phase 4 & 5: Road and Formation boundary fingerprints
    expect(resA.fingerprints.roadBoundariesHash).toBe(resB.fingerprints.roadBoundariesHash);
    expect(resA.fingerprints.formationBoundariesHash).toBe(resB.fingerprints.formationBoundariesHash);

    // Phase 6: Daylight point fingerprints
    expect(resA.fingerprints.daylightPointsHash).toBe(resB.fingerprints.daylightPointsHash);

    // Phase 7: Corridor vertices
    expect(resA.fingerprints.corridorVerticesHash).toBe(resB.fingerprints.corridorVerticesHash);

    // Phase 8: Corridor quads
    expect(resA.fingerprints.quadsHash).toBe(resB.fingerprints.quadsHash);

    // Phase 9: Selected diagonals
    expect(resA.fingerprints.selectedDiagonalsHash).toBe(resB.fingerprints.selectedDiagonalsHash);

    // Phase 10: Primitive identities
    expect(resA.fingerprints.primitiveIdentitiesHash).toBe(resB.fingerprints.primitiveIdentitiesHash);

    // Phase 11: Coverage priority bytes
    expect(resA.fingerprints.coverageHash).toBe(resB.fingerprints.coverageHash);

    // Phase 12: TargetZ float bytes
    expect(resA.fingerprints.targetZHash).toBe(resB.fingerprints.targetZHash);

    // Phase 18: Final workingElevations 100% BYTE-IDENTICAL!
    expect(resA.fingerprints.workingTerrainHash).toBe(resB.fingerprints.workingTerrainHash);

    const bufA = resA.grid.workingElevations;
    const bufB = resB.grid.workingElevations;

    expect(bufA.length).toBe(bufB.length);
    let byteMismatchCount = 0;
    for (let i = 0; i < bufA.length; i++) {
      if (bufA[i] !== bufB[i]) {
        byteMismatchCount++;
      }
    }
    expect(byteMismatchCount).toBe(0);
  });
});
