import type { CanonicalMesh } from '../core';
import type { ElevationModel } from '../elevation';
import type { SpatialRoadIndex } from './spatial-road-index';

export function sampleCorridorElevation(
  x: number,
  y: number,
  elevation: ElevationModel,
  spatialIndex: SpatialRoadIndex,
): number {
  const originalZ = elevation.sampleAbsoluteLocal(x, y);
  const candidates = spatialIndex.findCandidates(x, y);

  if (candidates.length === 0) return originalZ;

  // Find highest priority valid non-tunnel/bridge match
  for (const match of candidates) {
    if (match.segment.road.tunnel || match.segment.road.bridge) {
      continue;
    }

    const halfW = match.halfWidth;
    const shoulderW = match.shoulderWidth;
    const policy = match.segment.road.designPolicy;
    const roadZ = match.roadZ;

    const isCut = roadZ < originalZ;
    const heightDiff = Math.abs(roadZ - originalZ);
    const slopeRatio = isCut
      ? policy.cutSlopeHorizontalPerVertical
      : policy.fillSlopeHorizontalPerVertical;

    // Derived transition width from height difference (clamped between 4m and 35m)
    const transitionWidth = Math.max(4.0, Math.min(35.0, heightDiff * slopeRatio));

    const zoneA = halfW;
    const zoneB = halfW + shoulderW;
    const zoneC = zoneB + transitionWidth;

    const d = match.dist;

    if (d <= zoneA) {
      return roadZ;
    } else if (d <= zoneB) {
      return roadZ;
    } else if (d <= zoneC) {
      const u = (d - zoneB) / (zoneC - zoneB);
      // Smoothstep blend for natural slope transition
      const blend = u * u * (3 - 2 * u);
      return roadZ + blend * (originalZ - roadZ);
    }
  }

  return originalZ;
}

export function buildEngineeredTerrainMesh(
  halfExtentMetres: number,
  sizeMetres: number,
  elevation: ElevationModel,
  spatialIndex: SpatialRoadIndex,
): { mesh: CanonicalMesh; minimumElevationMetres: number; maximumElevationMetres: number } {
  const requestedIntervals = Math.round(sizeMetres / 12.5);
  const intervals = Math.max(40, Math.min(320, requestedIntervals));
  const size = intervals + 1;
  const step = (halfExtentMetres * 2) / intervals;
  const positions: number[] = [];
  const indices: number[] = [];
  let minimumElevationMetres = Number.POSITIVE_INFINITY;
  let maximumElevationMetres = Number.NEGATIVE_INFINITY;

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = -halfExtentMetres + column * step;
      const y = -halfExtentMetres + row * step;
      const finalAbsoluteElevation = sampleCorridorElevation(x, y, elevation, spatialIndex);
      const relativeElevation = finalAbsoluteElevation - elevation.anchorElevationMetres;

      minimumElevationMetres = Math.min(minimumElevationMetres, finalAbsoluteElevation);
      maximumElevationMetres = Math.max(maximumElevationMetres, finalAbsoluteElevation);
      positions.push(x, y, relativeElevation);
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const a = row * size + column;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  return {
    mesh: {
      id: `terrain-dem-${Math.round(sizeMetres)}m`,
      role: 'terrain',
      materialId: 'terrain-dem',
      positions,
      indices,
    },
    minimumElevationMetres,
    maximumElevationMetres,
  };
}
