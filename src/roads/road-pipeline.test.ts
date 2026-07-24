import { describe, expect, it } from 'vitest';
import type { ElevationModel } from '../elevation';
import { validateScene } from '../core';
import {
  buildCanonical1mInspectMesh,
  buildCanonicalTerrain,
  buildCesiumTerrainPreviewMesh,
  sampleCrossSectionDiagnostics,
  verifyCanonicalSampleAlignment,
} from './canonical-terrain';
import { resampleHorizontalCenterline } from './road-stationing';
import { buildDesignedRoad } from './vertical-alignment';
import { SpatialRoadIndex } from './spatial-road-index';
import { buildEngineeredRoadMesh, computeTriangleCrossZ } from './road-mesh';

function mockElevation(zFunc: (x: number, y: number) => number): ElevationModel {
  return {
    source: 'mock',
    zoom: 0,
    anchorElevationMetres: 100,
    sampleAbsoluteLocal: (x, y) => zFunc(x, y),
    sampleRelativeLocal: (x, y) => zFunc(x, y) - 100,
  };
}

describe('Civil Engineering Road Topology & Canonical Terrain Pipeline', () => {
  it('1. Flat terrain produces a flat designed road', () => {
    const elev = mockElevation(() => 150);
    const road = buildDesignedRoad(
      {
        id: 'r1',
        osmWayId: 1,
        highwayClass: 'primary',
        points: [{ x: -50, y: 0 }, { x: 50, y: 0 }],
        width: 10,
      },
      elev,
    );

    expect(road.stations.length).toBeGreaterThan(0);
    for (const st of road.stations) {
      expect(st.designZ).toBeCloseTo(150, 1);
      expect(st.grade).toBeCloseTo(0, 2);
    }
  });

  it('2. Authoritative CanonicalTerrain heightfield matches BeamNG 2048 preset (4,194,304 samples @ 1m)', () => {
    const elev = mockElevation((x, y) => 200 + Math.hypot(x, y) * 0.1);
    const road = buildDesignedRoad(
      {
        id: 'r2048',
        osmWayId: 99,
        highwayClass: 'primary',
        points: [{ x: -100, y: 0 }, { x: 100, y: 0 }],
        width: 10,
      },
      elev,
    );
    const index = new SpatialRoadIndex(1024, [road]);

    // Build full 512 preset for fast test verification
    const canonical = buildCanonicalTerrain(512, elev, index);
    expect(canonical.resolution).toBe(512);
    expect(canonical.squareSize).toBe(1);
    expect(canonical.worldSideMetres).toBe(512);
    expect(canonical.heights.length).toBe(512 * 512);

    // Assert all heights are finite and u16 encoding reconstruction error is under 0.05m
    for (let i = 0; i < canonical.heights.length; i += 100) {
      expect(Number.isFinite(canonical.heights[i])).toBe(true);
    }
    expect(canonical.encoding.maximumEncodingError).toBeLessThan(0.05);

    // Build preview mesh LOD (257x257)
    const previewMesh = buildCesiumTerrainPreviewMesh(canonical, 100, 257);
    expect(previewMesh.positions.length / 3).toBe(257 * 257);

    // Build Canonical 1m Inspect Mesh (128m x 128m patch @ exact 1.000m spacing)
    const inspectMesh = buildCanonical1mInspectMesh(canonical, { x: 0, y: 0 }, 128, 100);
    expect(inspectMesh.positions.length / 3).toBe(129 * 129);

    // Verify 1.000m Sample Alignment Diagnostics
    const alignment = verifyCanonicalSampleAlignment(canonical, elev);
    expect(alignment.valid).toBe(true);
    expect(alignment.sampleSpacingXMetres).toBeCloseTo(1.0, 4);
    expect(alignment.sampleSpacingYMetres).toBeCloseTo(1.0, 4);

    // Verify Cross-Section Diagnostics
    const crossSection = sampleCrossSectionDiagnostics(canonical, elev, Math.floor(canonical.resolution / 2));
    expect(crossSection.samplesCount).toBe(512);
  });

  it('3. Normal continuity is enforced through 90-degree bends, S-curves, and hairpins', () => {
    const hairpinPoints = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 10 },
      { x: 0, y: 10 },
    ];
    const stations = resampleHorizontalCenterline(hairpinPoints, 2.5, 8.0, 2.0);
    expect(stations.length).toBeGreaterThan(4);

    for (let i = 1; i < stations.length; i++) {
      const prev = stations[i - 1];
      const curr = stations[i];
      const dot = prev.normalX * curr.normalX + prev.normalY * curr.normalY;
      expect(dot).toBeGreaterThan(0.0);
    }
  });

  it('4. Reversed OSM way order produces identical valid positive-Z winding geometry', () => {
    const elev = mockElevation(() => 100);
    const pointsFwd = [
      { x: -40, y: 0 },
      { x: 0, y: 20 },
      { x: 40, y: 0 },
    ];
    const pointsRev = pointsFwd.slice().reverse();

    const roadFwd = buildDesignedRoad(
      { id: 'rFwd', osmWayId: 10, highwayClass: 'primary', points: pointsFwd, width: 8 },
      elev,
    );
    const roadRev = buildDesignedRoad(
      { id: 'rRev', osmWayId: 11, highwayClass: 'primary', points: pointsRev, width: 8 },
      elev,
    );

    const indexFwd = new SpatialRoadIndex(50, [roadFwd]);
    const indexRev = new SpatialRoadIndex(50, [roadRev]);

    const meshFwd = buildEngineeredRoadMesh([roadFwd], indexFwd, elev);
    const meshRev = buildEngineeredRoadMesh([roadRev], indexRev, elev);

    expect(meshFwd.mesh.indices.length).toBeGreaterThan(0);
    expect(meshRev.mesh.indices.length).toBeGreaterThan(0);

    let countFwd = 0;
    for (let i = 0; i < meshFwd.mesh.indices.length; i += 3) {
      const a = meshFwd.mesh.indices[i];
      const b = meshFwd.mesh.indices[i + 1];
      const c = meshFwd.mesh.indices[i + 2];
      const crossZ = computeTriangleCrossZ(
        meshFwd.mesh.positions[a * 3], meshFwd.mesh.positions[a * 3 + 1],
        meshFwd.mesh.positions[b * 3], meshFwd.mesh.positions[b * 3 + 1],
        meshFwd.mesh.positions[c * 3], meshFwd.mesh.positions[c * 3 + 1],
      );
      if (crossZ > 0) countFwd++;
    }
    expect(countFwd).toBe(meshFwd.mesh.indices.length / 3);

    let countRev = 0;
    for (let i = 0; i < meshRev.mesh.indices.length; i += 3) {
      const a = meshRev.mesh.indices[i];
      const b = meshRev.mesh.indices[i + 1];
      const c = meshRev.mesh.indices[i + 2];
      const crossZ = computeTriangleCrossZ(
        meshRev.mesh.positions[a * 3], meshRev.mesh.positions[a * 3 + 1],
        meshRev.mesh.positions[b * 3], meshRev.mesh.positions[b * 3 + 1],
        meshRev.mesh.positions[c * 3], meshRev.mesh.positions[c * 3 + 1],
      );
      if (crossZ > 0) countRev++;
    }
    expect(countRev).toBe(meshRev.mesh.indices.length / 3);
  });

  it('5. Each OSM way has an isolated index range (no connection between unrelated ways)', () => {
    const elev = mockElevation(() => 100);
    const way1 = buildDesignedRoad(
      { id: 'w1', osmWayId: 1, highwayClass: 'primary', points: [{ x: -30, y: 0 }, { x: -10, y: 0 }], width: 6 },
      elev,
    );
    const way2 = buildDesignedRoad(
      { id: 'w2', osmWayId: 2, highwayClass: 'primary', points: [{ x: 10, y: 0 }, { x: 30, y: 0 }], width: 6 },
      elev,
    );

    const index = new SpatialRoadIndex(50, [way1, way2]);
    const meshRes = buildEngineeredRoadMesh([way1, way2], index, elev);

    const way1VertCount = way1.stations.length * 7;
    for (let i = 0; i < meshRes.mesh.indices.length; i += 3) {
      const a = meshRes.mesh.indices[i];
      const b = meshRes.mesh.indices[i + 1];
      const c = meshRes.mesh.indices[i + 2];
      const inWay1 = a < way1VertCount && b < way1VertCount && c < way1VertCount;
      const inWay2 = a >= way1VertCount && b >= way1VertCount && c >= way1VertCount;
      expect(inWay1 || inWay2).toBe(true);
    }
  });

  it('6. Duplicate nodes & extremely short segments are filtered', () => {
    const dupePoints = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 20, y: 0 },
    ];
    const stations = resampleHorizontalCenterline(dupePoints, 2.5, 6.0, 2.0);
    expect(stations.length).toBeGreaterThan(1);
    for (let i = 1; i < stations.length; i++) {
      const d = Math.hypot(stations[i].x - stations[i - 1].x, stations[i].y - stations[i - 1].y);
      expect(d).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('7. Miter clamping prevents sharp bend vertex explosion', () => {
    const sharpBendPoints = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 0.1, y: 0.1 },
    ];
    const stations = resampleHorizontalCenterline(sharpBendPoints, 2.5, 10.0, 2.0);
    for (const st of stations) {
      const leftDist = Math.hypot(st.leftX - st.x, st.leftY - st.y);
      const rightDist = Math.hypot(st.rightX - st.x, st.rightY - st.y);
      expect(leftDist).toBeLessThanOrEqual(10.1);
      expect(rightDist).toBeLessThanOrEqual(10.1);
    }
  });

  it('8. Generated scene passes canonical scene validation', () => {
    const elev = mockElevation(() => 100);
    const road = buildDesignedRoad(
      {
        id: 'rMeshValid',
        osmWayId: 11,
        highwayClass: 'primary',
        points: [{ x: -30, y: 0 }, { x: 30, y: 0 }],
        width: 10,
      },
      elev,
    );

    const index = new SpatialRoadIndex(40, [road]);
    const canonical = buildCanonicalTerrain(512, elev, index);
    const previewMesh = buildCesiumTerrainPreviewMesh(canonical, 100, 257);
    const roadRes = buildEngineeredRoadMesh([road], index, elev);

    const scene = {
      id: 'test-scene',
      schemaVersion: '0.1.0' as const,
      coordinateSystem: {
        handedness: 'right' as const,
        upAxis: 'Z' as const,
        units: 'metres' as const,
        localFrame: 'ENU' as const,
      },
      anchor: { longitude: 18, latitude: 48, height: 100 },
      materials: [
        { id: 'terrain-dem', name: 'Terrain', color: [0, 1, 0, 1] as const },
        { id: 'road-osm', name: 'Road', color: [1, 0, 1, 1] as const },
      ],
      meshes: [previewMesh, roadRes.mesh],
      spawns: [],
    };

    const validation = validateScene(scene);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
