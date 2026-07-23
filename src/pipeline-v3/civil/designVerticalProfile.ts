import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { DesignedSumoStation, SumoPlanStation } from '../sumo/SumoGeometryV3';

export interface VerticalProfileConfig {
  maxLongitudinalGrade: number; // max dz/ds (e.g. 0.12 for 12% grade)
  smoothingWindowStations: number; // window size for vertical curves
  samplingIntervalMetres: number;
  profileEndpointPolicy: 'blend' | 'strict_match' | 'free';
  maxDeviationMetres: number;
}

export const GATE3_PRODUCTION_PROFILE_CONFIG: VerticalProfileConfig = {
  maxLongitudinalGrade: 0.12,
  smoothingWindowStations: 60,
  samplingIntervalMetres: 1.0,
  profileEndpointPolicy: 'blend',
  maxDeviationMetres: 50.0,
};

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

  // Real DEM ground-road profile
  const rawZ = stations.map((st) => grid.sampleSourceStrict(st.x, st.y));
  const config = GATE3_PRODUCTION_PROFILE_CONFIG;

  // 1. Smoothing (Moving Average)
  let smoothedZ = [...rawZ];
  const halfWindow = Math.floor(config.smoothingWindowStations / 2);
  for (let i = 0; i < rawZ.length; i++) {
    let sum = 0;
    let count = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < rawZ.length) {
        sum += rawZ[idx];
        count++;
      }
    }
    smoothedZ[i] = sum / count;
  }

  // 2. Enforce Max Deviation
  for (let i = 0; i < smoothedZ.length; i++) {
    const minZ = rawZ[i] - config.maxDeviationMetres;
    const maxZ = rawZ[i] + config.maxDeviationMetres;
    smoothedZ[i] = Math.max(minZ, Math.min(maxZ, smoothedZ[i]));
  }

  // 3. Enforce Max Longitudinal Grade (Forward and Backward Sweeps)
  for (let i = 1; i < smoothedZ.length; i++) {
    const ds = stations[i].station - stations[i - 1].station;
    if (ds > 0) {
      const maxDz = ds * config.maxLongitudinalGrade;
      const dz = smoothedZ[i] - smoothedZ[i - 1];
      if (dz > maxDz) smoothedZ[i] = smoothedZ[i - 1] + maxDz;
      if (dz < -maxDz) smoothedZ[i] = smoothedZ[i - 1] - maxDz;
    }
  }
  for (let i = smoothedZ.length - 2; i >= 0; i--) {
    const ds = stations[i + 1].station - stations[i].station;
    if (ds > 0) {
      const maxDz = ds * config.maxLongitudinalGrade;
      const dz = smoothedZ[i] - smoothedZ[i + 1];
      if (dz > maxDz) smoothedZ[i] = smoothedZ[i + 1] + maxDz;
      if (dz < -maxDz) smoothedZ[i] = smoothedZ[i + 1] - maxDz;
    }
  }

  const totalLength = stations[stations.length - 1].station;

  return stations.map((st, i) => {
    const groundZ = rawZ[i];
    let finishedSurfaceZ = smoothedZ[i];

    if (config.profileEndpointPolicy === 'blend') {
      if (startConstraintZ !== undefined) {
        const tStart = Math.min(1.0, st.station / 15.0);
        finishedSurfaceZ = (1 - tStart) * startConstraintZ + tStart * finishedSurfaceZ;
      }
      if (endConstraintZ !== undefined) {
        const distFromEnd = totalLength - st.station;
        const tEnd = Math.min(1.0, distFromEnd / 15.0);
        finishedSurfaceZ = (1 - tEnd) * endConstraintZ + tEnd * finishedSurfaceZ;
      }
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
