import type { CanonicalMesh } from '../core';
import type { ElevationModel } from '../elevation';
import { sampleCorridorElevation } from './road-corridor';
import type { SpatialRoadIndex } from './spatial-road-index';
import type { DesignedRoad } from './vertical-alignment';

export function computeTriangleCrossZ(
  pxA: number, pyA: number,
  pxB: number, pyB: number,
  pxC: number, pyC: number,
): number {
  return (pxB - pxA) * (pyC - pyA) - (pyB - pyA) * (pxC - pxA);
}

export function appendPositiveZTriangle(
  positions: number[],
  indices: number[],
  a: number,
  b: number,
  c: number,
): boolean {
  const ax = positions[a * 3], ay = positions[a * 3 + 1];
  const bx = positions[b * 3], by = positions[b * 3 + 1];
  const cx = positions[c * 3], cy = positions[c * 3 + 1];

  const crossZ = computeTriangleCrossZ(ax, ay, bx, by, cx, cy);

  if (Math.abs(crossZ) < 1e-5) {
    return false; // Degenerate zero-area triangle
  }

  if (crossZ > 0) {
    indices.push(a, b, c);
  } else {
    indices.push(a, c, b);
  }
  return true;
}

export function buildEngineeredRoadMesh(
  roads: DesignedRoad[],
  spatialIndex: SpatialRoadIndex,
  elevation: ElevationModel,
): { mesh: CanonicalMesh; segments: number; length: number } {
  const positions: number[] = [];
  const indices: number[] = [];
  let totalSegments = 0;
  let totalLength = 0;

  const formationClearance = 0.05; // 5cm above formation bed

  for (const road of roads) {
    // Specification 1: KEEP EVERY OSM WAY SEPARATE
    if (road.stations.length < 2) continue;

    const wayVertexStart = positions.length / 3;

    // Build vertices for this road way
    for (let i = 0; i < road.stations.length; i++) {
      const st = road.stations[i];
      const leftX = st.leftX;
      const leftY = st.leftY;
      const rightX = st.rightX;
      const rightY = st.rightY;

      const centerZ = road.tunnel
        ? st.designZ
        : sampleCorridorElevation(st.x, st.y, elevation, spatialIndex);
      const relativeZ = centerZ - elevation.anchorElevationMetres + formationClearance;
      const crossfallDrop = (st.roadWidth / 2) * st.crossfall;
      const edgeZ = relativeZ - crossfallDrop;

      // Order per station: ALWAYS left_i, right_i
      positions.push(
        leftX, leftY, edgeZ,
        rightX, rightY, edgeZ,
      );

      if (i > 0) {
        totalLength += Math.hypot(st.x - road.stations[i - 1].x, st.y - road.stations[i - 1].y);
      }
    }

    // Build continuous quad ribbon for this road way
    for (let i = 0; i < road.stations.length - 1; i++) {
      const stCurr = road.stations[i];
      const stNext = road.stations[i + 1];

      // Skip duplicate / zero length stations
      if (Math.hypot(stNext.x - stCurr.x, stNext.y - stCurr.y) < 0.01) continue;

      const idxLeftCurr = wayVertexStart + i * 2;
      const idxRightCurr = idxLeftCurr + 1;
      const idxLeftNext = idxLeftCurr + 2;
      const idxRightNext = idxLeftCurr + 3;

      // Guarantee an unbroken, continuous ribbon across all adjacent station pairs
      const t1OK = appendPositiveZTriangle(positions, indices, idxLeftCurr, idxRightCurr, idxRightNext);
      const t2OK = appendPositiveZTriangle(positions, indices, idxLeftCurr, idxRightNext, idxLeftNext);

      if (t1OK || t2OK) {
        totalSegments += 1;
      }
    }
  }

  return {
    mesh: {
      id: 'roads-osm-live',
      role: 'road',
      materialId: 'road-osm',
      positions,
      indices,
    },
    segments: totalSegments,
    length: totalLength,
  };
}
