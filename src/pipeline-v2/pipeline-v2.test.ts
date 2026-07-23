import { describe, expect, it } from 'vitest';
import {
  createTerrainGridTransformV2,
  gridColumnToLocalX,
  gridRowToLocalY,
  localXToGridColumn,
  localYToGridRow,
} from './terrain/terrain-grid-transform';
import { createCanonicalTerrainV2 } from './terrain/canonical-terrain-v2';
import { resampleRoadStationingV2 } from './roads/road-stationing-v2';
import { buildVerticalProfileV2 } from './roads/vertical-profile-v2';
import { buildRoadMeshV2PhaseA } from './roads/road-mesh-v2';
import { SpatialIndexV2 } from './roads/spatial-index-v2';
import { applyRoadFormationV2 } from './roads/terrain-corridor-v2';
import { solveRoadTerrainCoupledV3 } from './roads/coupled-solver-v3';

describe('Pipeline V2/V3 - Coupled Road-Terrain Feasibility & Acceptance Gates', () => {
  it('GATE 1 — Grid Transform: 1 column/row diff = exactly 1.000m without rotation', () => {
    const transform = createTerrainGridTransformV2(512);

    expect(transform.squareSize).toBe(1);
    expect(transform.worldSizeMetres).toBe(512);
    expect(transform.originX).toBe(-256);
    expect(transform.originY).toBe(-256);

    const x0 = gridColumnToLocalX(transform, 0);
    const x1 = gridColumnToLocalX(transform, 1);
    expect(x1 - x0).toBeCloseTo(1.0, 6);

    const y0 = gridRowToLocalY(transform, 0);
    const y1 = gridRowToLocalY(transform, 1);
    expect(y1 - y0).toBeCloseTo(1.0, 6);

    expect(localXToGridColumn(transform, -256)).toBe(0);
    expect(localYToGridRow(transform, -256)).toBe(0);
    expect(localXToGridColumn(transform, 0)).toBe(256);
    expect(localYToGridRow(transform, 0)).toBe(256);
  });

  it('GATE 2 — Straight Road: Synthetic BeamNG 512 Flat Terrain produces exact 8m width & positive Z winding', () => {
    const terrain = createCanonicalTerrainV2(512, () => 0.0);
    const rawPoints = [{ x: -200, y: 0 }, { x: 200, y: 0 }];

    const stations = resampleRoadStationingV2(rawPoints, 1.0);
    expect(stations.length).toBe(401); // 400m / 1m + 1 = 401 stations

    const profiled = buildVerticalProfileV2(stations, terrain);
    const way = { id: 'straight-8m', roadWidthMetres: 8.0, stations: profiled };

    const meshResult = buildRoadMeshV2PhaseA([way]);
    expect(meshResult.segmentsCount).toBe(400);

    const pos = meshResult.mesh.positions;
    const ind = meshResult.mesh.indices;

    // Verify exact 8m width on all vertices
    for (let i = 0; i < pos.length; i += 12) {
      const aLeft = { x: pos[i], y: pos[i + 1] };
      const aRight = { x: pos[i + 3], y: pos[i + 4] };
      const width = Math.hypot(aRight.x - aLeft.x, aRight.y - aLeft.y);
      expect(width).toBeCloseTo(8.0, 4);
    }

    // Verify 100% positive Z CCW winding order
    let positiveCount = 0;
    for (let i = 0; i < ind.length; i += 3) {
      const a = ind[i];
      const b = ind[i + 1];
      const c = ind[i + 2];

      const ax = pos[a * 3], ay = pos[a * 3 + 1];
      const bx = pos[b * 3], by = pos[b * 3 + 1];
      const cx = pos[c * 3], cy = pos[c * 3 + 1];

      const crossZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (crossZ > 0) positiveCount++;
    }

    expect(positiveCount).toBe(ind.length / 3);
  });

  it('GATE 3 — Flat Formation Bed: Formation bed is designZ - 0.25m and surface is designZ + 0.05m (0.30m delta)', () => {
    const terrain = createCanonicalTerrainV2(512, () => 100.0);
    const rawPoints = [{ x: -100, y: 0 }, { x: 100, y: 0 }];

    const stations = resampleRoadStationingV2(rawPoints, 1.0);
    const profiled = buildVerticalProfileV2(stations, terrain);
    const way = { id: 'test-bed', roadWidthMetres: 8.0, stations: profiled };

    const spatialIndex = new SpatialIndexV2(256, [way]);

    applyRoadFormationV2(terrain, [way], spatialIndex, {
      shoulderWidthMetres: 1.0,
      pavementThicknessMetres: 0.25,
      fillRatio: 2.0,
      cutRatio: 2.0,
      enableSideSlopes: false, // Flat formation test
    });

    const meshResult = buildRoadMeshV2PhaseA([way]);

    // Check center sample workingHeight vs roadSurfaceZ
    const centerCol = localXToGridColumn(terrain.transform, 0);
    const centerRow = localYToGridRow(terrain.transform, 0);
    const centerIdx = centerRow * 512 + centerCol;

    const workingHeight = terrain.workingHeights[centerIdx];
    const roadSurfaceZ = meshResult.mesh.positions[2]; // Z of first vertex

    expect(workingHeight).toBeCloseTo(99.75, 2); // 100 - 0.25
    expect(roadSurfaceZ).toBeCloseTo(100.05, 2); // 100 + 0.05
    expect(roadSurfaceZ - workingHeight).toBeCloseTo(0.30, 2);
  });

  it('GATE 4 — Cut & Fill Slopes: Gaussian hill cut & valley fill 1V:2H slope transitions', () => {
    const terrain = createCanonicalTerrainV2(512, (x, y) => 100.0 + 30.0 * Math.exp(-(x * x + y * y) / 2000.0));
    const rawPoints = [{ x: -200, y: 0 }, { x: 200, y: 0 }];

    const stations = resampleRoadStationingV2(rawPoints, 1.0);
    const profiled = buildVerticalProfileV2(stations, terrain);
    const way = { id: 'hill-cut', roadWidthMetres: 8.0, stations: profiled };

    const spatialIndex = new SpatialIndexV2(256, [way]);

    applyRoadFormationV2(terrain, [way], spatialIndex, {
      shoulderWidthMetres: 1.0,
      pavementThicknessMetres: 0.25,
      fillRatio: 2.0,
      cutRatio: 2.0,
      enableSideSlopes: true,
    });

    const centerCol = localXToGridColumn(terrain.transform, 0);
    const centerRow = localYToGridRow(terrain.transform, 0);
    const centerIdx = centerRow * 512 + centerCol;

    expect(terrain.sourceHeights[centerIdx]).toBeCloseTo(130.0, 1);
    expect(terrain.workingHeights[centerIdx]).toBeLessThan(110.0); // Cut hill top down
  });

  it('GATE 6 (V3 Solver) — Coupled Feasibility Solver: Solves road Z and terrain feasibility together without accumulated corruption', () => {
    const terrain = createCanonicalTerrainV2(512, (x, y) => 100.0 + (x * 0.05)); // 5% continuous grade hill
    const rawPoints = [{ x: -100, y: 0 }, { x: 100, y: 0 }];

    const stations = resampleRoadStationingV2(rawPoints, 1.0);
    const result = solveRoadTerrainCoupledV3(stations, terrain, 8.0);

    expect(result.converged).toBe(true);
    expect(result.maxRoadToFormationGap).toBeCloseTo(0.30, 2);
    expect(result.solvedStations.length).toBe(stations.length);

    // Verify 100% of stations maintain roadSurfaceZ = formationZ + 0.30m
    for (const st of result.solvedStations) {
      expect(st.roadSurfaceZ - st.formationZ).toBeCloseTo(0.30, 4);
    }
  });
});
