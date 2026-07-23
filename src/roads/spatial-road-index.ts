import type { DesignedRoad, DesignedRoadStation } from './vertical-alignment';

export interface RoadSegmentRef {
  p1: DesignedRoadStation;
  p2: DesignedRoadStation;
  road: DesignedRoad;
}

export interface CandidateMatch {
  segment: RoadSegmentRef;
  dist: number;
  t: number;
  roadZ: number;
  halfWidth: number;
  shoulderWidth: number;
}

export class SpatialRoadIndex {
  private cellSize: number = 40.0;
  private grid: Map<string, RoadSegmentRef[]> = new Map();
  private halfExtent: number;

  constructor(halfExtent: number, roads: DesignedRoad[]) {
    this.halfExtent = halfExtent;

    for (const road of roads) {
      if (road.stations.length < 2) continue;

      const halfW = road.stations[0].roadWidth / 2;
      const shoulderW = road.stations[0].shoulderWidth;
      const maxCutFillDist = Math.max(road.maximumCut, road.maximumFill) * 2.0 + 10.0;
      const influenceRadius = halfW + shoulderW + maxCutFillDist + 5.0;

      for (let i = 0; i < road.stations.length - 1; i++) {
        const p1 = road.stations[i];
        const p2 = road.stations[i + 1];
        const ref: RoadSegmentRef = { p1, p2, road };

        const minX = Math.min(p1.x, p2.x) - influenceRadius;
        const maxX = Math.max(p1.x, p2.x) + influenceRadius;
        const minY = Math.min(p1.y, p2.y) - influenceRadius;
        const maxY = Math.max(p1.y, p2.y) + influenceRadius;

        const startCol = Math.floor((minX + halfExtent) / this.cellSize);
        const endCol = Math.floor((maxX + halfExtent) / this.cellSize);
        const startRow = Math.floor((minY + halfExtent) / this.cellSize);
        const endRow = Math.floor((maxY + halfExtent) / this.cellSize);

        for (let r = startRow; r <= endRow; r++) {
          for (let c = startCol; c <= endCol; c++) {
            const key = `${c}:${r}`;
            let list = this.grid.get(key);
            if (!list) {
              list = [];
              this.grid.set(key, list);
            }
            list.push(ref);
          }
        }
      }
    }
  }

  public findCandidates(x: number, y: number): CandidateMatch[] {
    const col = Math.floor((x + this.halfExtent) / this.cellSize);
    const row = Math.floor((y + this.halfExtent) / this.cellSize);
    const results: CandidateMatch[] = [];

    // Inspect current cell and 8 neighboring cells
    const checkedRefs = new Set<RoadSegmentRef>();

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const key = `${col + dc}:${row + dr}`;
        const list = this.grid.get(key);
        if (!list) continue;

        for (const ref of list) {
          if (checkedRefs.has(ref)) continue;
          checkedRefs.add(ref);

          const { dist, t } = pointSegmentDistance2D(x, y, ref.p1, ref.p2);
          const roadZ = ref.p1.designZ + t * (ref.p2.designZ - ref.p1.designZ);
          results.push({
            segment: ref,
            dist,
            t,
            roadZ,
            halfWidth: ref.p1.roadWidth / 2,
            shoulderWidth: ref.p1.shoulderWidth,
          });
        }
      }
    }

    // Deterministic priority ordering: nearest formation surface, then higher highway class
    results.sort((a, b) => {
      const highwayPriority: Record<string, number> = {
        motorway: 5,
        trunk: 4,
        primary: 3,
        secondary: 2,
        tertiary: 1,
      };
      const prioA = highwayPriority[a.segment.road.highwayClass] ?? 0;
      const prioB = highwayPriority[b.segment.road.highwayClass] ?? 0;
      if (prioA !== prioB) return prioB - prioA;
      return a.dist - b.dist;
    });

    return results;
  }
}

function pointSegmentDistance2D(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): { dist: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;

  if (l2 < 1e-6) {
    return { dist: Math.hypot(px - a.x, py - a.y), t: 0 };
  }

  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return { dist: Math.hypot(px - projX, py - projY), t };
}
