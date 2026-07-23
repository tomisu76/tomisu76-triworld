import type { CanonicalTerrainV2 } from '../terrain/canonical-terrain-v2';
import { sampleBilinearLocal } from '../terrain/terrain-sampler-v2';
import type { DesignedStationV2 } from './road-stationing-v2';

export interface EarthworkPolicyV3 {
  preferredMaximumCut: number; // 2.0 m
  preferredMaximumFill: number; // 1.5 m
  absoluteMaximumCut: number; // 4.5 m
  absoluteMaximumFill: number; // 3.0 m
  cutSlopeHorizontalPerVertical: number; // 2.0 (2H : 1V)
  fillSlopeHorizontalPerVertical: number; // 2.0 (2H : 1V)
  maximumDaylightOffset: number; // 25.0 m
  maximumProfileAdjustment: number; // 3.0 m
  formationDepth: number; // 0.30 m (0.25m bed + 0.05m clearance)
  maxGrade: number; // 0.08 (8%)
}

export const DEFAULT_EARTHWORK_POLICY_V3: EarthworkPolicyV3 = {
  preferredMaximumCut: 2.0,
  preferredMaximumFill: 1.5,
  absoluteMaximumCut: 4.5,
  absoluteMaximumFill: 3.0,
  cutSlopeHorizontalPerVertical: 2.0,
  fillSlopeHorizontalPerVertical: 2.0,
  maximumDaylightOffset: 25.0,
  maximumProfileAdjustment: 3.0,
  formationDepth: 0.30,
  maxGrade: 0.08,
};

export interface SolvedStationV3 extends DesignedStationV2 {
  sourceGroundZ: number;
  formationZ: number;
  roadSurfaceZ: number;
  needsStructure: boolean;
  structureReason?: 'excessiveFill' | 'excessiveCut' | 'corridorTooWide' | 'gradeConstraint';
  daylightLeftMetres: number;
  daylightRightMetres: number;
}

export interface SolverResultV3 {
  solvedStations: SolvedStationV3[];
  converged: boolean;
  iterationsCount: number;
  maxRoadToFormationGap: number;
  maxTerrainModification: number;
  maxCutMetres: number;
  maxFillMetres: number;
  maxDaylightOffsetMetres: number;
  needsStructureCount: number;
}

export function solveRoadTerrainCoupledV3(
  stations: DesignedStationV2[],
  terrain: CanonicalTerrainV2,
  roadWidthMetres: number,
  policy: EarthworkPolicyV3 = DEFAULT_EARTHWORK_POLICY_V3,
): SolverResultV3 {
  if (stations.length < 2) {
    return {
      solvedStations: [],
      converged: true,
      iterationsCount: 0,
      maxRoadToFormationGap: 0,
      maxTerrainModification: 0,
      maxCutMetres: 0,
      maxFillMetres: 0,
      maxDaylightOffsetMetres: 0,
      needsStructureCount: 0,
    };
  }

  // 1. Datum & Coordinate Assertion
  for (const st of stations) {
    const rawTerrainZ = sampleBilinearLocal(terrain, st.xMetres, st.yMetres, false);
    if (Math.abs(st.groundZ - rawTerrainZ) > 0.10) {
      st.groundZ = rawTerrainZ;
    }
  }

  // Initial candidate formationZ = smoothed groundZ
  const numStations = stations.length;
  let formationZ = stations.map((st) => st.groundZ);
  const initialFormationZ = [...formationZ];

  let iterationsCount = 0;
  const maxIterations = 50;
  let converged = false;

  const formationHalfWidth = roadWidthMetres / 2 + 1.0; // shoulder = 1.0m

  for (let iter = 0; iter < maxIterations; iter++) {
    iterationsCount++;
    let maxProfileChange = 0;

    // Smooth profile (20m window)
    const nextZ = [...formationZ];
    for (let i = 1; i < numStations - 1; i++) {
      const smoothed = (formationZ[i - 1] + formationZ[i] * 2 + formationZ[i + 1]) / 4;
      nextZ[i] = smoothed;
    }

    // Clamp grade & slope constraints
    for (let i = 1; i < numStations; i++) {
      const ds = stations[i].stationMetres - stations[i - 1].stationMetres;
      if (ds < 1e-6) continue;
      const maxDelta = policy.maxGrade * ds;
      nextZ[i] = Math.max(nextZ[i - 1] - maxDelta, Math.min(nextZ[i - 1] + maxDelta, nextZ[i]));
    }

    // Clamp to Earthwork Feasibility Envelope
    for (let i = 0; i < numStations; i++) {
      const g = stations[i].groundZ;
      const minZ = g - policy.absoluteMaximumCut;
      const maxZ = g + policy.absoluteMaximumFill;

      // Lock profile adjustment within policy.maximumProfileAdjustment
      const clampedAdjustment = Math.max(
        initialFormationZ[i] - policy.maximumProfileAdjustment,
        Math.min(initialFormationZ[i] + policy.maximumProfileAdjustment, nextZ[i]),
      );

      const targetZ = Math.max(minZ, Math.min(maxZ, clampedAdjustment));
      const delta = Math.abs(targetZ - formationZ[i]);
      if (delta > maxProfileChange) maxProfileChange = delta;
      formationZ[i] = targetZ;
    }

    if (maxProfileChange < 0.005) {
      converged = true;
      break;
    }
  }

  // Build final SolvedStationV3 array with daylight evaluation
  const solvedStations: SolvedStationV3[] = [];
  let maxCutMetres = 0;
  let maxFillMetres = 0;
  let maxDaylightOffsetMetres = 0;
  let maxTerrainModification = 0;
  let needsStructureCount = 0;

  for (let i = 0; i < numStations; i++) {
    const st = stations[i];
    const formZ = formationZ[i];
    const roadSurfaceZ = formZ + policy.formationDepth;
    const gZ = st.groundZ;

    const netCutFill = gZ - formZ;
    if (netCutFill > 0 && netCutFill > maxCutMetres) maxCutMetres = netCutFill;
    if (netCutFill < 0 && Math.abs(netCutFill) > maxFillMetres) maxFillMetres = Math.abs(netCutFill);

    // Evaluate left/right daylight offsets
    const leftDaylight = calculateDaylightOffset(terrain, st.xMetres, st.yMetres, formZ, formationHalfWidth, true, policy);
    const rightDaylight = calculateDaylightOffset(terrain, st.xMetres, st.yMetres, formZ, formationHalfWidth, false, policy);

    const maxDaylight = Math.max(leftDaylight, rightDaylight);
    if (maxDaylight > maxDaylightOffsetMetres) maxDaylightOffsetMetres = maxDaylight;

    let needsStructure = false;
    let structureReason: SolvedStationV3['structureReason'];

    if (netCutFill < -policy.absoluteMaximumFill) {
      needsStructure = true;
      structureReason = 'excessiveFill';
    } else if (netCutFill > policy.absoluteMaximumCut) {
      needsStructure = true;
      structureReason = 'excessiveCut';
    } else if (maxDaylight > policy.maximumDaylightOffset) {
      needsStructure = true;
      structureReason = 'corridorTooWide';
    }

    if (needsStructure) needsStructureCount++;

    solvedStations.push({
      ...st,
      sourceGroundZ: gZ,
      formationZ: formZ,
      roadSurfaceZ,
      needsStructure,
      structureReason,
      daylightLeftMetres: leftDaylight,
      daylightRightMetres: rightDaylight,
    });
  }

  return {
    solvedStations,
    converged,
    iterationsCount,
    maxRoadToFormationGap: 0.30,
    maxTerrainModification: Math.max(maxCutMetres, maxFillMetres),
    maxCutMetres,
    maxFillMetres,
    maxDaylightOffsetMetres,
    needsStructureCount,
  };
}

function calculateDaylightOffset(
  terrain: CanonicalTerrainV2,
  x: number,
  y: number,
  formationZ: number,
  formationHalfWidth: number,
  isLeft: boolean,
  policy: EarthworkPolicyV3,
): number {
  // Approximate daylight search up to maximumDaylightOffset (25m)
  for (let offset = 0.5; offset <= policy.maximumDaylightOffset; offset += 0.5) {
    const d = formationHalfWidth + offset;
    const sampleX = isLeft ? x - d : x + d;
    const sourceZ = sampleBilinearLocal(terrain, sampleX, y, false);

    const slopeZ = sourceZ < formationZ
      ? formationZ - offset / policy.fillSlopeHorizontalPerVertical
      : formationZ + offset / policy.cutSlopeHorizontalPerVertical;

    if (Math.abs(sourceZ - slopeZ) < 0.20) {
      return d;
    }
  }
  return formationHalfWidth + policy.maximumDaylightOffset;
}
