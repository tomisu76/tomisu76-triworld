import type { ElevationModel } from '../elevation';
import { getRoadDesignPolicy, type RoadDesignPolicy } from './road-design-policy';
import { resampleHorizontalCenterline, type LocalPoint } from './road-stationing';

export interface DesignedRoadStation {
  station: number;
  x: number;
  y: number;
  groundZ: number;
  designZ: number;
  grade: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  roadWidth: number;
  shoulderWidth: number;
  crossfall: number;
}

export interface VerticalCurveDebug {
  incomingGrade: number;
  outgoingGrade: number;
  curveLength: number;
  type: 'crest' | 'sag';
  startStation: number;
  endStation: number;
}

export interface DesignedRoad {
  id: string;
  osmWayId: number;
  highwayClass: string;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  stations: DesignedRoadStation[];
  designPolicy: RoadDesignPolicy;
  maximumCut: number;
  maximumFill: number;
  totalCutVolumeEstimate: number;
  totalFillVolumeEstimate: number;
  verticalCurves: VerticalCurveDebug[];
}

export interface RoadInput {
  id: string;
  osmWayId: number;
  highwayClass: string;
  points: LocalPoint[];
  width: number;
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
  lockedStartZ?: number;
  lockedEndZ?: number;
}

export function buildDesignedRoad(
  input: RoadInput,
  elevation: ElevationModel,
): DesignedRoad {
  const policy = getRoadDesignPolicy(input.highwayClass);
  const horizontalStations = resampleHorizontalCenterline(
    input.points,
    policy.stationSpacing,
    input.width,
    2.0, // miterLimit
  );

  if (horizontalStations.length === 0) {
    return {
      id: input.id,
      osmWayId: input.osmWayId,
      highwayClass: input.highwayClass,
      bridge: Boolean(input.bridge),
      tunnel: Boolean(input.tunnel),
      layer: input.layer ?? 0,
      stations: [],
      designPolicy: policy,
      maximumCut: 0,
      maximumFill: 0,
      totalCutVolumeEstimate: 0,
      totalFillVolumeEstimate: 0,
      verticalCurves: [],
    };
  }

  // 1. Sample raw ground Z
  const groundZ: number[] = horizontalStations.map((hs) => elevation.sampleAbsoluteLocal(hs.x, hs.y));

  // 2. Short-wavelength noise & micro-bump smoothing filter (37.5m Gaussian window)
  const smoothedGroundZ: number[] = [];
  const windowRadius = 7; // 7 stations * 2.5m = ~17.5m radius (35m window)
  for (let i = 0; i < groundZ.length; i++) {
    let sum = 0;
    let wSum = 0;
    for (let r = -windowRadius; r <= windowRadius; r++) {
      const idx = Math.max(0, Math.min(groundZ.length - 1, i + r));
      const distInMetres = r * policy.stationSpacing;
      const w = Math.exp(-(distInMetres * distInMetres) / 200.0);
      sum += groundZ[idx] * w;
      wSum += w;
    }
    smoothedGroundZ.push(sum / wSum);
  }

  // Lock endpoints if provided
  if (input.lockedStartZ !== undefined) smoothedGroundZ[0] = input.lockedStartZ;
  if (input.lockedEndZ !== undefined) smoothedGroundZ[smoothedGroundZ.length - 1] = input.lockedEndZ;

  // 3. Grade slope clamping pass with 12m maximum cut/fill envelope
  const finalDesignZ = [...smoothedGroundZ];
  const maxGrade = policy.absoluteMaximumGrade;

  // Bound initial target within 12.0m of groundZ
  for (let i = 0; i < finalDesignZ.length; i++) {
    finalDesignZ[i] = Math.max(
      smoothedGroundZ[i] - 12.0,
      Math.min(smoothedGroundZ[i] + 12.0, finalDesignZ[i]),
    );
  }

  for (let pass = 0; pass < 8; pass++) {
    // Forward pass
    for (let i = 1; i < finalDesignZ.length; i++) {
      const ds = horizontalStations[i].station - horizontalStations[i - 1].station || 1;
      const maxDz = ds * maxGrade;
      finalDesignZ[i] = Math.max(
        finalDesignZ[i - 1] - maxDz,
        Math.min(finalDesignZ[i - 1] + maxDz, finalDesignZ[i]),
      );
    }
    // Backward pass
    for (let i = finalDesignZ.length - 2; i >= 0; i--) {
      const ds = horizontalStations[i + 1].station - horizontalStations[i].station || 1;
      const maxDz = ds * maxGrade;
      finalDesignZ[i] = Math.max(
        finalDesignZ[i + 1] - maxDz,
        Math.min(finalDesignZ[i + 1] + maxDz, finalDesignZ[i]),
      );
    }
  }

  // 4. Parabolic vertical curve transitions pass
  const verticalCurves: VerticalCurveDebug[] = [];

  // Identify PVI (Points of Vertical Intersection) and apply parabolic transitions
  for (let i = 2; i < finalDesignZ.length - 2; i++) {
    const sPrev = horizontalStations[i - 1].station - horizontalStations[i - 2].station;
    const sNext = horizontalStations[i + 2].station - horizontalStations[i + 1].station;
    const gIn = (finalDesignZ[i] - finalDesignZ[i - 2]) / (horizontalStations[i].station - horizontalStations[i - 2].station || 1);
    const gOut = (finalDesignZ[i + 2] - finalDesignZ[i]) / (horizontalStations[i + 2].station - horizontalStations[i].station || 1);

    const gradeChange = Math.abs(gOut - gIn);
    if (gradeChange > 0.015) {
      const curveLen = Math.max(policy.minimumVerticalCurveLength, gradeChange * 200.0);
      const isCrest = gIn > gOut;
      verticalCurves.push({
        incomingGrade: gIn,
        outgoingGrade: gOut,
        curveLength: curveLen,
        type: isCrest ? 'crest' : 'sag',
        startStation: Math.max(0, horizontalStations[i].station - curveLen / 2),
        endStation: Math.min(horizontalStations[horizontalStations.length - 1].station, horizontalStations[i].station + curveLen / 2),
      });

      // Smooth parabolic vertex transition
      finalDesignZ[i] = finalDesignZ[i] * 0.6 + ((finalDesignZ[i - 1] + finalDesignZ[i + 1]) / 2) * 0.4;
    }
  }

  // 5. Build station objects and earthwork stats
  let maximumCut = 0;
  let maximumFill = 0;
  let totalCutVolume = 0;
  let totalFillVolume = 0;

  const stations: DesignedRoadStation[] = [];
  const count = horizontalStations.length;

  for (let i = 0; i < count; i++) {
    const hs = horizontalStations[i];
    const gz = groundZ[i];
    const dz = finalDesignZ[i];

    const prevS = horizontalStations[Math.max(0, i - 1)];
    const nextS = horizontalStations[Math.min(count - 1, i + 1)];
    const ds = nextS.station - prevS.station || 1;
    const grade = (nextS.station === prevS.station) ? 0 : (finalDesignZ[Math.min(count - 1, i + 1)] - finalDesignZ[Math.max(0, i - 1)]) / ds;

    const diff = dz - gz;
    if (diff < 0) {
      maximumCut = Math.max(maximumCut, Math.abs(diff));
      totalCutVolume += Math.abs(diff) * input.width * policy.stationSpacing;
    } else {
      maximumFill = Math.max(maximumFill, diff);
      totalFillVolume += diff * input.width * policy.stationSpacing;
    }

    stations.push({
      station: hs.station,
      x: hs.x,
      y: hs.y,
      groundZ: gz,
      designZ: dz,
      grade,
      tangentX: hs.tangentX,
      tangentY: hs.tangentY,
      normalX: hs.normalX,
      normalY: hs.normalY,
      leftX: hs.leftX,
      leftY: hs.leftY,
      rightX: hs.rightX,
      rightY: hs.rightY,
      roadWidth: input.width,
      shoulderWidth: policy.shoulderWidth,
      crossfall: policy.crossfall,
    });
  }

  return {
    id: input.id,
    osmWayId: input.osmWayId,
    highwayClass: input.highwayClass,
    bridge: Boolean(input.bridge),
    tunnel: Boolean(input.tunnel),
    layer: input.layer ?? 0,
    stations,
    designPolicy: policy,
    maximumCut,
    maximumFill,
    totalCutVolumeEstimate: totalCutVolume,
    totalFillVolumeEstimate: totalFillVolume,
    verticalCurves,
  };
}
