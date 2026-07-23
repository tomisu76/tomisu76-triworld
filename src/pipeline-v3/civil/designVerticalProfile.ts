import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { DesignedSumoStation, SumoPlanStation } from '../sumo/SumoGeometryV3';

export function designVerticalProfileV3(
  stations: readonly SumoPlanStation[],
  grid: TerrainGridV3,
  useSyntheticValidationProfile: boolean = false,
  startConstraintZ?: number,
  endConstraintZ?: number,
): DesignedSumoStation[] {
  if (stations.length === 0) return [];

  if (useSyntheticValidationProfile) {
    return stations.map((st) => {
      const groundZ = grid.sampleSourceStrict(st.x, st.y);
      const finishedSurfaceZ = 0.20 + 0.0015 * st.x - 0.0007 * st.y;
      const pavementDepth = 0.30;
      const subgradeZ = finishedSurfaceZ - pavementDepth;

      return {
        ...st,
        groundZ,
        designZ: finishedSurfaceZ,
        formationZ: finishedSurfaceZ, // Ground Road Mode: TerrainBlock Z equals finishedSurfaceZ directly
        surfaceZ: finishedSurfaceZ,
      };
    });
  }

  // Real DEM ground-road profile: Smooth ground elevation along global station sequence
  const rawZ = stations.map((st) => grid.sampleSourceStrict(st.x, st.y));

  // 5-station moving average filter for smooth grade transitions
  const smoothedZ = rawZ.map((_, idx) => {
    let sum = 0;
    let count = 0;
    for (let k = -2; k <= 2; k++) {
      const i = idx + k;
      if (i >= 0 && i < rawZ.length) {
        sum += rawZ[i];
        count++;
      }
    }
    return sum / count;
  });

  const totalLength = stations[stations.length - 1].station;

  return stations.map((st, i) => {
    const groundZ = rawZ[i];
    let finishedSurfaceZ = smoothedZ[i];

    // Smoothly blend start constraint (Junction Node at start) over 15.0m
    if (startConstraintZ !== undefined) {
      const tStart = Math.min(1.0, st.station / 15.0);
      finishedSurfaceZ = (1 - tStart) * startConstraintZ + tStart * finishedSurfaceZ;
    }

    // Smoothly blend end constraint (Junction Node at end) over 15.0m
    if (endConstraintZ !== undefined) {
      const distFromEnd = totalLength - st.station;
      const tEnd = Math.min(1.0, distFromEnd / 15.0);
      finishedSurfaceZ = (1 - tEnd) * endConstraintZ + tEnd * finishedSurfaceZ;
    }

    const pavementDepth = 0.30;
    const subgradeZ = finishedSurfaceZ - pavementDepth; // Internal earthworks record

    return {
      ...st,
      groundZ,
      designZ: finishedSurfaceZ,
      formationZ: finishedSurfaceZ, // Ground Road Mode: workingTerrainZ equals finishedSurfaceZ
      surfaceZ: finishedSurfaceZ,
    };
  });
}
