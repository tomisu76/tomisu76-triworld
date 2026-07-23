import { generateCustomPng } from './texture-generator';
import type { GisTerrainResult } from './gis-terrain';
import type { RoadTerrainConfig, RoadTerrainResult } from './road-terrain';
import { buildMountainLoopRoadTerrain as buildLayeredRoadTerrain } from './road-terrain-gate3';

export interface BakedRoadTerrainResult extends RoadTerrainResult {
  roadMaskU8: Uint8Array;
  bakedDiffusePng: Uint8Array;
}

/**
 * BeamNG 0.36-safe visual packaging for Gate 3.
 *
 * BeamNG rendered a magenta fringe where the generated ASPHALT terrain layer
 * blended into the ground layer. To remove that engine-side material failure,
 * the road mask is baked into one north-up base texture and the native .ter is
 * emitted with exactly one valid terrain material. Heightfield cut/fill and the
 * road-first 3D alignment remain unchanged.
 */
export function buildBakedMountainLoopRoadTerrain(
  base: GisTerrainResult,
  overrides: Partial<RoadTerrainConfig> = {},
): BakedRoadTerrainResult {
  const layered = buildLayeredRoadTerrain(base, overrides);
  const roadMaskU8 = Uint8Array.from(
    layered.artifact.layerMapU8,
    (value) => value === 1 ? 255 : 0,
  );

  const size = layered.artifact.size;
  const bakedDiffusePng = generateCustomPng(size, size, (x, y) => {
    const index = y * size + x;
    const isRoad = roadMaskU8[index] !== 0;
    if (isRoad) {
      // Neutral dark asphalt. Small deterministic variation avoids a flat,
      // featureless appearance without introducing external assets.
      const grain = ((x * 17 + y * 31) % 9) - 4;
      return [52 + grain, 53 + grain, 55 + grain];
    }

    // Green terrain with gentle deterministic variation.
    const variation = ((x * 7 + y * 13) % 13) - 6;
    return [64 + variation, 137 + variation, 51 + variation];
  });

  return {
    ...layered,
    artifact: {
      ...layered.artifact,
      layerMapU8: new Uint8Array(size * size),
      materialNames: ['triworld_v4_ground'],
    },
    roadMaskU8,
    bakedDiffusePng,
  };
}
