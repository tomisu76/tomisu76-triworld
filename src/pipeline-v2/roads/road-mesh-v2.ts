import type { CanonicalMesh } from '../../core';
import type { DesignedStationV2 } from './road-stationing-v2';

export interface RoadWayV2 {
  id: string;
  roadWidthMetres: number;
  stations: DesignedStationV2[];
}

export function buildRoadMeshV2PhaseA(
  ways: RoadWayV2[],
): { mesh: CanonicalMesh; segmentsCount: number; totalLengthMetres: number } {
  const positions: number[] = [];
  const indices: number[] = [];
  let segmentsCount = 0;
  let totalLengthMetres = 0;

  const roadSurfaceOffsetZ = 0.05; // 5cm clearance above designZ

  for (const way of ways) {
    if (way.stations.length < 2) continue;

    const halfWidth = way.roadWidthMetres / 2;

    for (let i = 0; i < way.stations.length - 1; i++) {
      const stA = way.stations[i];
      const stB = way.stations[i + 1];

      const dx = stB.xMetres - stA.xMetres;
      const dy = stB.yMetres - stA.yMetres;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) continue;

      const tx = dx / len;
      const ty = dy / len;

      // Normal vector to tangent (left is +90 deg)
      const nx = -ty;
      const ny = tx;

      const zA = stA.designZ + roadSurfaceOffsetZ;
      const zB = stB.designZ + roadSurfaceOffsetZ;

      // Station A vertices
      const aLeftX = stA.xMetres + nx * halfWidth;
      const aLeftY = stA.yMetres + ny * halfWidth;
      const aRightX = stA.xMetres - nx * halfWidth;
      const aRightY = stA.yMetres - ny * halfWidth;

      // Station B vertices
      const bLeftX = stB.xMetres + nx * halfWidth;
      const bLeftY = stB.yMetres + ny * halfWidth;
      const bRightX = stB.xMetres - nx * halfWidth;
      const bRightY = stB.yMetres - ny * halfWidth;

      const vertStart = positions.length / 3;

      // Push 4 segment vertices
      positions.push(
        aLeftX, aLeftY, zA,  // vertStart + 0
        aRightX, aRightY, zA, // vertStart + 1
        bLeftX, bLeftY, zB,  // vertStart + 2
        bRightX, bRightY, zB, // vertStart + 3
      );

      // Triangle 1: A_left (0), A_right (1), B_right (3)
      // Triangle 2: A_left (0), B_right (3), B_left (2)
      // Positive Z CCW winding order
      indices.push(
        vertStart + 0, vertStart + 1, vertStart + 3,
        vertStart + 0, vertStart + 3, vertStart + 2,
      );

      segmentsCount++;
      totalLengthMetres += len;
    }
  }

  return {
    mesh: {
      id: 'roads-v2-phase-a',
      role: 'road',
      materialId: 'road-osm',
      positions,
      indices,
    },
    segmentsCount,
    totalLengthMetres,
  };
}
