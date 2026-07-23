import type { CanonicalTerrainV2 } from '../terrain/canonical-terrain-v2';
import { sampleBilinearLocal } from '../terrain/terrain-sampler-v2';
import type { DesignedStationV2 } from './road-stationing-v2';

export interface VerticalProfileConfigV2 {
  smoothingWindowMetres: number; // e.g. 20.0 metres
  maxGrade: number; // e.g. 0.08 (8%)
}

export const DEFAULT_PROFILE_CONFIG_V2: VerticalProfileConfigV2 = {
  smoothingWindowMetres: 20.0,
  maxGrade: 0.08,
};

export function buildVerticalProfileV2(
  stations: DesignedStationV2[],
  terrain: CanonicalTerrainV2,
  config: VerticalProfileConfigV2 = DEFAULT_PROFILE_CONFIG_V2,
): DesignedStationV2[] {
  if (stations.length < 2) return stations;

  // 1. Sample groundZ in metres directly from canonical terrain
  const groundZ: number[] = [];
  for (const st of stations) {
    const gz = sampleBilinearLocal(terrain, st.xMetres, st.yMetres, false);
    st.groundZ = gz;
    groundZ.push(gz);
  }

  // 2. Metre-based Gaussian smoothing
  const stationSpacingMetres = stations.length > 1 ? (stations[stations.length - 1].stationMetres / (stations.length - 1)) : 1.0;
  const windowRadiusStations = Math.max(1, Math.round(config.smoothingWindowMetres / (2 * stationSpacingMetres)));

  const smoothedZ: number[] = [];
  for (let i = 0; i < groundZ.length; i++) {
    let sum = 0;
    let wSum = 0;
    for (let r = -windowRadiusStations; r <= windowRadiusStations; r++) {
      const idx = Math.max(0, Math.min(groundZ.length - 1, i + r));
      const distMetres = r * stationSpacingMetres;
      const w = Math.exp(-(distMetres * distMetres) / (2 * config.smoothingWindowMetres * config.smoothingWindowMetres));
      sum += groundZ[idx] * w;
      wSum += w;
    }
    smoothedZ.push(sum / wSum);
  }

  // 3. Slope grade clamping: grade = deltaZ / deltaStationMetres
  const designZ = [...smoothedZ];
  for (let i = 1; i < designZ.length; i++) {
    const ds = stations[i].stationMetres - stations[i - 1].stationMetres;
    if (ds < 1e-6) continue;
    const maxDelta = config.maxGrade * ds;
    designZ[i] = Math.max(designZ[i - 1] - maxDelta, Math.min(designZ[i - 1] + maxDelta, designZ[i]));
  }

  // Assign designZ
  return stations.map((st, idx) => ({
    ...st,
    designZ: designZ[idx],
  }));
}
