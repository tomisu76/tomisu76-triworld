import type { DesignedStationV2 } from './road-stationing-v2';

export interface RoadSegmentV2Ref {
  p1: DesignedStationV2;
  p2: DesignedStationV2;
  roadWidthMetres: number;
}

export interface NearestSegmentMatchV2 {
  segment: RoadSegmentV2Ref;
  distanceMetres: number;
  t: number;
  designZ: number;
  roadWidthMetres: number;
}

export class SpatialIndexV2 {
  private bucketSizeMetres: number = 32.0;
  private grid: Map<string, RoadSegmentV2Ref[]> = new Map();
  private halfExtentMetres: number;

  constructor(halfExtentMetres: number, ways: Array<{ roadWidthMetres: number; stations: DesignedStationV2[] }>) {
    this.halfExtentMetres = halfExtentMetres;

    for (const way of ways) {
      if (way.stations.length < 2) continue;
      const influenceRadius = way.roadWidthMetres / 2 + 25.0; // 25m max slope radius

      for (let i = 0; i < way.stations.length - 1; i++) {
        const p1 = way.stations[i];
        const p2 = way.stations[i + 1];
        const ref: RoadSegmentV2Ref = { p1, p2, roadWidthMetres: way.roadWidthMetres };

        const minX = Math.min(p1.xMetres, p2.xMetres) - influenceRadius;
        const maxX = Math.max(p1.xMetres, p2.xMetres) + influenceRadius;
        const minY = Math.min(p1.yMetres, p2.yMetres) - influenceRadius;
        const maxY = Math.max(p1.yMetres, p2.yMetres) + influenceRadius;

        const startCol = Math.floor((minX + halfExtentMetres) / this.bucketSizeMetres);
        const endCol = Math.floor((maxX + halfExtentMetres) / this.bucketSizeMetres);
        const startRow = Math.floor((minY + halfExtentMetres) / this.bucketSizeMetres);
        const endRow = Math.floor((maxY + halfExtentMetres) / this.bucketSizeMetres);

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

  public findNearestSegment(xMetres: number, yMetres: number): NearestSegmentMatchV2 | null {
    const col = Math.floor((xMetres + this.halfExtentMetres) / this.bucketSizeMetres);
    const row = Math.floor((yMetres + this.halfExtentMetres) / this.bucketSizeMetres);

    const checkedRefs = new Set<RoadSegmentV2Ref>();
    let nearest: NearestSegmentMatchV2 | null = null;
    let minDist = Number.POSITIVE_INFINITY;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const key = `${col + dc}:${row + dr}`;
        const list = this.grid.get(key);
        if (!list) continue;

        for (const ref of list) {
          if (checkedRefs.has(ref)) continue;
          checkedRefs.add(ref);

          const { dist, t } = pointSegmentDistance2D(
            xMetres, yMetres,
            ref.p1.xMetres, ref.p1.yMetres,
            ref.p2.xMetres, ref.p2.yMetres,
          );

          if (dist < minDist) {
            minDist = dist;
            const designZ = ref.p1.designZ + t * (ref.p2.designZ - ref.p1.designZ);
            nearest = {
              segment: ref,
              distanceMetres: dist,
              t,
              designZ,
              roadWidthMetres: ref.roadWidthMetres,
            };
          }
        }
      }
    }

    return nearest;
  }
}

function pointSegmentDistance2D(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;

  if (l2 < 1e-6) {
    return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  }

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return { dist: Math.hypot(px - projX, py - projY), t };
}
