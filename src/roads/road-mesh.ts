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
      const laneCentreZ = (relativeZ + edgeZ) / 2;
      const leftShoulderX = leftX + st.normalX * st.shoulderWidth;
      const leftShoulderY = leftY + st.normalY * st.shoulderWidth;
      const rightShoulderX = rightX - st.normalX * st.shoulderWidth;
      const rightShoulderY = rightY - st.normalY * st.shoulderWidth;

      // Order per station: left shoulder, road edge, lane centre, crown,
      // right lane centre, road edge, shoulder.
      positions.push(
        leftShoulderX, leftShoulderY, edgeZ,
        leftX, leftY, edgeZ,
        (leftX + st.x) / 2, (leftY + st.y) / 2, laneCentreZ,
        st.x, st.y, relativeZ,
        (rightX + st.x) / 2, (rightY + st.y) / 2, laneCentreZ,
        rightX, rightY, edgeZ,
        rightShoulderX, rightShoulderY, edgeZ,
      );

      if (i > 0) {
        totalLength += Math.hypot(st.x - road.stations[i - 1].x, st.y - road.stations[i - 1].y);
      }
    }

    // Build six continuous quad strips for this road way.
    for (let i = 0; i < road.stations.length - 1; i++) {
      const stCurr = road.stations[i];
      const stNext = road.stations[i + 1];

      // Skip duplicate / zero length stations
      if (Math.hypot(stNext.x - stCurr.x, stNext.y - stCurr.y) < 0.01) continue;

      const idxCurr = wayVertexStart + i * 7;
      const idxNext = idxCurr + 7;
      let segmentHasTriangles = false;

      for (let strip = 0; strip < 6; strip++) {
        const leftCurr = idxCurr + strip;
        const rightCurr = leftCurr + 1;
        const leftNext = idxNext + strip;
        const rightNext = leftNext + 1;
        const t1OK = appendPositiveZTriangle(positions, indices, leftCurr, rightCurr, rightNext);
        const t2OK = appendPositiveZTriangle(positions, indices, leftCurr, rightNext, leftNext);
        segmentHasTriangles ||= t1OK || t2OK;
      }

      if (segmentHasTriangles) {
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
