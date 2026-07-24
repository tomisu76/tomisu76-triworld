import type { DesignedSumoStation } from '../sumo/SumoGeometryV3';
import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { TransactionResultV3 } from './corridorTransaction';
import {
  PRIORITY_GROUND_ROAD_SURFACE,
  SENTINEL_UINT32,
} from './fixedPointRasterizer';

export interface FormationCoverageResultV3 {
  coveredCellCount: number;
  replacedCellCount: number;
  halfWidthMetres: number;
}

/**
 * Guarantees a continuous, deterministic formation bed beneath the complete
 * physical road cross-section. The triangle transaction remains authoritative
 * wherever it already produced formation. Only uncovered/slope cells inside
 * the road tube are repaired, using the transaction's segment ownership to
 * prevent a nearby but topologically unrelated bend from supplying elevation.
 */
export function enforceContinuousFormationCoverageV3(
  stations: readonly DesignedSumoStation[],
  grid: TerrainGridV3,
  transaction: TransactionResultV3,
  laneHalfWidthMetres: number,
  shoulderWidthMetres: number = 1.0,
  safetyZoneMetres: number = 1.5,
): FormationCoverageResultV3 {
  if (stations.length < 2) {
    return {
      coveredCellCount: 0,
      replacedCellCount: 0,
      halfWidthMetres: laneHalfWidthMetres + shoulderWidthMetres + safetyZoneMetres,
    };
  }
  if (transaction.status !== 'success' || !transaction.buffers || !transaction.nextWorkingElevations) {
    throw new Error('Continuous formation coverage requires a successful corridor transaction.');
  }
  for (const [name, value] of [
    ['laneHalfWidthMetres', laneHalfWidthMetres],
    ['shoulderWidthMetres', shoulderWidthMetres],
    ['safetyZoneMetres', safetyZoneMetres],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and >= 0, received ${value}.`);
    }
  }

  const buffers = transaction.buffers;
  const halfWidthMetres = laneHalfWidthMetres + shoulderWidthMetres + safetyZoneMetres;
  const halfWidthSquared = halfWidthMetres * halfWidthMetres;
  const cellCount = grid.N * grid.N;
  const bestTopologyDistance = new Float64Array(cellCount);
  bestTopologyDistance.fill(Number.POSITIVE_INFINITY);
  const bestDistanceSquared = new Float64Array(cellCount);
  bestDistanceSquared.fill(Number.POSITIVE_INFINITY);
  const bestSegment = new Uint32Array(cellCount);
  bestSegment.fill(SENTINEL_UINT32);
  const bestFormationZ = new Float64Array(cellCount);
  bestFormationZ.fill(Number.NaN);

  const lastSegmentIndex = stations.length - 2;
  for (let segmentIndex = 0; segmentIndex < stations.length - 1; segmentIndex++) {
    const station0 = stations[segmentIndex];
    const station1 = stations[segmentIndex + 1];

    const startPad = segmentIndex === 0 ? safetyZoneMetres : 0;
    const endPad = segmentIndex === lastSegmentIndex ? safetyZoneMetres : 0;
    const x0 = station0.x - station0.tangentX * startPad;
    const y0 = station0.y - station0.tangentY * startPad;
    const x1 = station1.x + station1.tangentX * endPad;
    const y1 = station1.y + station1.tangentY * endPad;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const segmentLengthSquared = dx * dx + dy * dy;
    if (segmentLengthSquared <= 1e-12) continue;

    const minX = Math.min(x0, x1) - halfWidthMetres;
    const maxX = Math.max(x0, x1) + halfWidthMetres;
    const minY = Math.min(y0, y1) - halfWidthMetres;
    const maxY = Math.max(y0, y1) + halfWidthMetres;
    const minColumn = Math.max(0, Math.floor(grid.xToContinuousColumn(minX)));
    const maxColumn = Math.min(grid.N - 1, Math.ceil(grid.xToContinuousColumn(maxX)));
    const minRow = Math.max(0, Math.floor(grid.yToContinuousRow(maxY)));
    const maxRow = Math.min(grid.N - 1, Math.ceil(grid.yToContinuousRow(minY)));

    for (let row = minRow; row <= maxRow; row++) {
      const y = grid.rowToY(row);
      for (let column = minColumn; column <= maxColumn; column++) {
        const index = row * grid.N + column;

        // Never replace a formation value produced by the canonical triangle
        // transaction. This avoids cross-talk between spatially close bends.
        if (buffers.priority[index] === PRIORITY_GROUND_ROAD_SURFACE) continue;

        const x = grid.columnToX(column);
        const unclampedT = ((x - x0) * dx + (y - y0) * dy) / segmentLengthSquared;
        const t = Math.max(0, Math.min(1, unclampedT));
        const nearestX = x0 + t * dx;
        const nearestY = y0 + t * dy;
        const distanceX = x - nearestX;
        const distanceY = y - nearestY;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;
        if (distanceSquared > halfWidthSquared + 1e-9) continue;

        const ownerSegment = buffers.segmentRank[index];
        const topologyDistance = ownerSegment === SENTINEL_UINT32
          ? 0
          : Math.abs(segmentIndex - ownerSegment);
        const existingTopologyDistance = bestTopologyDistance[index];
        const existingDistance = bestDistanceSquared[index];
        const existingSegment = bestSegment[index];
        const wins = topologyDistance < existingTopologyDistance ||
          (topologyDistance === existingTopologyDistance &&
            (distanceSquared < existingDistance - 1e-9 ||
              (Math.abs(distanceSquared - existingDistance) <= 1e-9 && segmentIndex < existingSegment)));
        if (!wins) continue;

        // Pads keep the endpoint formation elevation constant. Inside the
        // physical segment, interpolate the designed formation continuously.
        const physicalX0 = station0.x;
        const physicalY0 = station0.y;
        const physicalDx = station1.x - station0.x;
        const physicalDy = station1.y - station0.y;
        const physicalLengthSquared = physicalDx * physicalDx + physicalDy * physicalDy;
        const physicalT = physicalLengthSquared <= 1e-12
          ? 0
          : Math.max(0, Math.min(
              1,
              ((nearestX - physicalX0) * physicalDx + (nearestY - physicalY0) * physicalDy) /
                physicalLengthSquared,
            ));
        const formationZ = station0.formationZ +
          (station1.formationZ - station0.formationZ) * physicalT;

        bestTopologyDistance[index] = topologyDistance;
        bestDistanceSquared[index] = distanceSquared;
        bestSegment[index] = segmentIndex;
        bestFormationZ[index] = formationZ;
      }
    }
  }

  const nextWorking = transaction.nextWorkingElevations;
  let coveredCellCount = 0;
  let replacedCellCount = 0;

  for (let index = 0; index < cellCount; index++) {
    const formationZ = bestFormationZ[index];
    if (!Number.isFinite(formationZ)) continue;
    coveredCellCount += 1;
    if (Math.abs(nextWorking[index] - formationZ) > 1e-6) {
      replacedCellCount += 1;
    }

    nextWorking[index] = formationZ;
    grid.workingElevations[index] = formationZ;
    buffers.priority[index] = PRIORITY_GROUND_ROAD_SURFACE;
    buffers.targetZ[index] = formationZ;
    buffers.segmentRank[index] = bestSegment[index];
    buffers.primitiveRank[index] = 0;
    buffers.slopeOwnerSegmentRank[index] = SENTINEL_UINT32;
    buffers.slopeOwnerPrimitiveRank[index] = SENTINEL_UINT32;
  }

  return { coveredCellCount, replacedCellCount, halfWidthMetres };
}
