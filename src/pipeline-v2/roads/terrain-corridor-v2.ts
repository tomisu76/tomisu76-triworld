import type { CanonicalTerrainV2 } from '../terrain/canonical-terrain-v2';
import {
  gridColumnToLocalX,
  gridRowToLocalY,
} from '../terrain/terrain-grid-transform';
import type { RoadWayV2 } from './road-mesh-v2';
import { SpatialIndexV2 } from './spatial-index-v2';

export interface FormationConfigV2 {
  shoulderWidthMetres: number; // 1.0 m
  pavementThicknessMetres: number; // 0.25 m
  fillRatio: number; // 2.0 (1V : 2H)
  cutRatio: number; // 2.0 (1V : 2H)
  enableSideSlopes: boolean;
}

export const DEFAULT_FORMATION_CONFIG_V2: FormationConfigV2 = {
  shoulderWidthMetres: 1.0,
  pavementThicknessMetres: 0.25,
  fillRatio: 2.0,
  cutRatio: 2.0,
  enableSideSlopes: true,
};

export function applyRoadFormationV2(
  terrain: CanonicalTerrainV2,
  ways: RoadWayV2[],
  spatialIndex: SpatialIndexV2,
  config: FormationConfigV2 = DEFAULT_FORMATION_CONFIG_V2,
): void {
  const resolution = terrain.resolution;

  for (let r = 0; r < resolution; r++) {
    const yMetres = gridRowToLocalY(terrain.transform, r);
    for (let c = 0; c < resolution; c++) {
      const xMetres = gridColumnToLocalX(terrain.transform, c);

      const match = spatialIndex.findNearestSegment(xMetres, yMetres);
      if (!match) continue;

      const roadHalfWidth = match.roadWidthMetres / 2;
      const formationHalfWidth = roadHalfWidth + config.shoulderWidthMetres;
      const edgeZ = match.designZ - config.pavementThicknessMetres;

      const idx = r * resolution + c;
      const sourceZ = terrain.sourceHeights[idx];

      if (match.distanceMetres <= formationHalfWidth) {
        // Inside formation bed: flat pavement formation Z
        terrain.workingHeights[idx] = edgeZ;
      } else if (config.enableSideSlopes) {
        // Outside formation bed: 1V:2H slope transition
        const run = match.distanceMetres - formationHalfWidth;

        if (sourceZ < edgeZ) {
          // Fill candidate
          const fillSlopeZ = edgeZ - run / config.fillRatio;
          if (sourceZ < fillSlopeZ) {
            terrain.workingHeights[idx] = fillSlopeZ;
          }
        } else if (sourceZ > edgeZ) {
          // Cut candidate
          const cutSlopeZ = edgeZ + run / config.cutRatio;
          if (sourceZ > cutSlopeZ) {
            terrain.workingHeights[idx] = cutSlopeZ;
          }
        }
      }
    }
  }
}
