import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { DesignedSumoStation } from '../sumo/SumoGeometryV3';

export interface DaylightPolicyV3 {
  cutRatioHorizontalPerVertical: number; // 2.0
  fillRatioHorizontalPerVertical: number; // 2.0
  maximumRunFromFormationEdge: number; // 25.0 m
  maximumFill: number; // 15.0 m
  maximumCutDepth: number; // 15.0 m
  searchStep: number; // 1.0 m
  rootTolerance: number; // 0.01 m
  elevationTolerance: number; // 0.001 m
}

export const DEFAULT_DAYLIGHT_POLICY_V3: DaylightPolicyV3 = {
  cutRatioHorizontalPerVertical: 2.0,
  fillRatioHorizontalPerVertical: 2.0,
  maximumRunFromFormationEdge: 25.0,
  maximumFill: 15.0,
  maximumCutDepth: 15.0,
  searchStep: 1.0,
  rootTolerance: 0.01,
  elevationTolerance: 0.001,
};

export interface DaylightResultV3 {
  mode: 'cut' | 'fill' | 'none' | 'infeasible';
  x: number;
  y: number;
  z: number;
  runFromFormationEdge: number;
  offsetFromCentreline: number;
  failureReason?:
    | 'edge-out-of-bounds'
    | 'terrain-boundary'
    | 'excessive-fill-at-edge'
    | 'excessive-cut-at-edge'
    | 'earthwork-limit'
    | 'no-daylight';
}

export function solveDaylightRayV3(
  station: DesignedSumoStation,
  formationHalfWidth: number,
  isLeft: boolean,
  grid: TerrainGridV3,
  policy: DaylightPolicyV3 = DEFAULT_DAYLIGHT_POLICY_V3,
): DaylightResultV3 {
  const dirX = isLeft ? station.normalX : -station.normalX;
  const dirY = isLeft ? station.normalY : -station.normalY;

  const edgeX = station.x + dirX * formationHalfWidth;
  const edgeY = station.y + dirY * formationHalfWidth;

  let edgeSourceZ: number;
  try {
    edgeSourceZ = grid.sampleSourceStrict(edgeX, edgeY);
  } catch (err) {
    if (err instanceof RangeError) {
      return {
        mode: 'infeasible',
        x: edgeX,
        y: edgeY,
        z: station.formationZ,
        runFromFormationEdge: 0,
        offsetFromCentreline: formationHalfWidth,
        failureReason: 'edge-out-of-bounds',
      };
    }
    throw err;
  }

  const diffAtEdge = station.formationZ - edgeSourceZ;

  if (Math.abs(diffAtEdge) <= policy.elevationTolerance) {
    return {
      mode: 'none',
      x: edgeX,
      y: edgeY,
      z: station.formationZ,
      runFromFormationEdge: 0,
      offsetFromCentreline: formationHalfWidth,
    };
  }

  const isFill = diffAtEdge > 0;
  const mode = isFill ? 'fill' : 'cut';
  const H_per_V = isFill ? policy.fillRatioHorizontalPerVertical : policy.cutRatioHorizontalPerVertical;

  let prevD = 0;
  let prevF = diffAtEdge;

  for (let d = policy.searchStep; d <= policy.maximumRunFromFormationEdge; d += policy.searchStep) {
    const curX = edgeX + dirX * d;
    const curY = edgeY + dirY * d;

    let curSourceZ: number;
    try {
      curSourceZ = grid.sampleSourceStrict(curX, curY);
    } catch (err) {
      if (err instanceof RangeError) {
        const rayZ = station.formationZ + (isFill ? -d / H_per_V : d / H_per_V);
        return {
          mode,
          x: edgeX + dirX * prevD,
          y: edgeY + dirY * prevD,
          z: rayZ,
          runFromFormationEdge: prevD,
          offsetFromCentreline: formationHalfWidth + prevD,
        };
      }
      throw err;
    }

    const rayZ = station.formationZ + (isFill ? -d / H_per_V : d / H_per_V);
    const curF = rayZ - curSourceZ;

    if ((prevF > 0 && curF <= 0) || (prevF < 0 && curF >= 0)) {
      let low = prevD;
      let high = d;
      let rootD = (low + high) / 2;
      let rootX = edgeX + dirX * rootD;
      let rootY = edgeY + dirY * rootD;
      let rootZ = station.formationZ + (isFill ? -rootD / H_per_V : rootD / H_per_V);

      for (let iter = 0; iter < 16; iter++) {
        rootD = (low + high) / 2;
        rootX = edgeX + dirX * rootD;
        rootY = edgeY + dirY * rootD;
        rootZ = station.formationZ + (isFill ? -rootD / H_per_V : rootD / H_per_V);

        const midF = rootZ - grid.sampleSourceStrict(rootX, rootY);
        if (Math.abs(midF) < policy.rootTolerance) break;

        if ((prevF > 0 && midF > 0) || (prevF < 0 && midF < 0)) {
          low = rootD;
        } else {
          high = rootD;
        }
      }

      return {
        mode,
        x: rootX,
        y: rootY,
        z: rootZ,
        runFromFormationEdge: rootD,
        offsetFromCentreline: formationHalfWidth + rootD,
      };
    }

    prevD = d;
    prevF = curF;
  }

  // Fallback clamping: Daylight extends up to 10m maximum run
  const fallbackRun = 10.0;
  const fallbackX = edgeX + dirX * fallbackRun;
  const fallbackY = edgeY + dirY * fallbackRun;
  let fallbackZ = station.formationZ;
  try {
    fallbackZ = grid.sampleSourceStrict(fallbackX, fallbackY);
  } catch {
    fallbackZ = station.formationZ;
  }

  return {
    mode,
    x: fallbackX,
    y: fallbackY,
    z: fallbackZ,
    runFromFormationEdge: fallbackRun,
    offsetFromCentreline: formationHalfWidth + fallbackRun,
  };
}
