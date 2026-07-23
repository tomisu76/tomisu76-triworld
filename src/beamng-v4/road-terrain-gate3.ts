import type { GisTerrainResult } from './gis-terrain';
import {
  buildMountainLoopRoadTerrain as buildInitialMountainLoop,
  type RoadTerrainConfig,
  type RoadTerrainNode,
  type RoadTerrainResult,
} from './road-terrain';

const DEFAULT_CONFIG: RoadTerrainConfig = {
  roadWidth: 7.2,
  shoulderWidth: 1.4,
  blendWidth: 15.0,
  stationSpacing: 7.5,
  maxGrade: 0.095,
  maxBank: 0.075,
  designSpeedMetresPerSecond: 18.0,
};

/**
 * Gate 3 hardened entry point.
 *
 * The initial road designer produces the horizontal alignment, preliminary
 * vertical profile and superelevation. This final pass solves the CLOSED
 * vertical profile to numerical convergence, then deforms the terrain again
 * from the corrected formation. This prevents a residual grade violation at
 * the seam between the last and first station on large maps.
 */
export function buildMountainLoopRoadTerrain(
  base: GisTerrainResult,
  overrides: Partial<RoadTerrainConfig> = {},
): RoadTerrainResult {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const initial = buildInitialMountainLoop(base, overrides);
  const nodes = initial.roadNodes.map((node) => ({ ...node }));
  const segmentLengths = calculateSegmentLengths(nodes);

  const elevations = Float64Array.from(nodes, (node) => node.z);
  // A small safety margin absorbs serialization rounding without changing the
  // intended 9.5% design policy.
  const numericalGradeLimit = Math.max(0, config.maxGrade - 0.00005);
  enforceClosedGradeLimit(elevations, segmentLengths, numericalGradeLimit);

  for (let index = 0; index < nodes.length; index++) {
    nodes[index].z = round(elevations[index], 6);
  }

  const deformation = deformTerrainFromFinalRoad(
    initial.originalElevations,
    base.artifact.size,
    base.artifact.squareSize,
    nodes,
    config,
    base.artifact.layerMapU8,
  );

  const heightMapU16 = quantizeElevations(deformation.elevations, base.artifact.heightScale);
  const decodedBounds = scanDecodedBounds(heightMapU16, base.artifact.heightScale);
  const roadLengthMetres = segmentLengths.reduce((sum, value) => sum + value, 0);
  const maximumAbsoluteGrade = calculateMaximumGrade(nodes, segmentLengths);
  const maximumAbsoluteBank = nodes.reduce(
    (maximum, node) => Math.max(maximum, Math.abs(node.bank)),
    0,
  );

  const closedNodes = [
    ...nodes,
    { ...nodes[0], station: round(roadLengthMetres, 4) },
  ];
  const roadObject = {
    ...initial.roadObject,
    nodes: closedNodes.map((node) => [
      node.x,
      node.y,
      round(node.z + 0.025, 6),
      node.width,
    ]),
  };
  const roadSpawn = createRoadSpawn(nodes[0], nodes[1]);

  return {
    artifact: {
      ...base.artifact,
      heightMapU16,
      layerMapU8: deformation.layerMap,
      materialNames: ['triworld_v4_ground', 'ASPHALT'],
      minimumDecodedElevation: decodedBounds.minimum,
      maximumDecodedElevation: decodedBounds.maximum,
    },
    originalElevations: new Float32Array(initial.originalElevations),
    deformedElevations: deformation.elevations,
    roadNodes: nodes,
    roadObject,
    roadSpawn,
    stats: {
      roadLengthMetres,
      stationCount: nodes.length,
      maximumAbsoluteGrade,
      maximumAbsoluteBank,
      minimumCutFillMetres: deformation.minimumCutFill,
      maximumCutFillMetres: deformation.maximumCutFill,
      modifiedSampleCount: deformation.modifiedSampleCount,
      asphaltSampleCount: deformation.asphaltSampleCount,
    },
    sampleElevation: (xMetres: number, yMetres: number) => sampleGridBilinear(
      deformation.elevations,
      base.artifact.size,
      base.artifact.squareSize,
      xMetres,
      yMetres,
    ),
  };
}

function calculateSegmentLengths(nodes: readonly RoadTerrainNode[]): Float64Array {
  const lengths = new Float64Array(nodes.length);
  for (let index = 0; index < nodes.length; index++) {
    const next = nodes[(index + 1) % nodes.length];
    lengths[index] = Math.hypot(next.x - nodes[index].x, next.y - nodes[index].y);
    if (!(lengths[index] > 0)) {
      throw new Error(`Road station ${index} has zero horizontal segment length`);
    }
  }
  return lengths;
}

function enforceClosedGradeLimit(
  elevations: Float64Array,
  segmentLengths: Float64Array,
  maxGrade: number,
): void {
  const toleranceMetres = 1e-9;
  const maximumPasses = 50_000;

  for (let pass = 0; pass < maximumPasses; pass++) {
    let maximumExcess = 0;

    for (let index = 0; index < elevations.length; index++) {
      const next = (index + 1) % elevations.length;
      const allowedDelta = maxGrade * segmentLengths[index];
      const delta = elevations[next] - elevations[index];
      const excess = Math.abs(delta) - allowedDelta;
      if (excess <= toleranceMetres) continue;

      maximumExcess = Math.max(maximumExcess, excess);
      const correction = excess * 0.5;
      const direction = Math.sign(delta);
      elevations[index] += direction * correction;
      elevations[next] -= direction * correction;
    }

    if (maximumExcess <= toleranceMetres) return;
  }

  const remainingGrade = calculateMaximumGradeFromElevations(elevations, segmentLengths);
  if (remainingGrade > maxGrade + 1e-8) {
    throw new Error(
      `Closed vertical profile did not converge: ${(remainingGrade * 100).toFixed(6)}% > ${(maxGrade * 100).toFixed(6)}%`,
    );
  }
}

function deformTerrainFromFinalRoad(
  original: Float32Array,
  size: number,
  squareSize: number,
  nodes: readonly RoadTerrainNode[],
  config: RoadTerrainConfig,
  originalLayerMap: Uint8Array,
): {
  elevations: Float32Array;
  layerMap: Uint8Array;
  minimumCutFill: number;
  maximumCutFill: number;
  modifiedSampleCount: number;
  asphaltSampleCount: number;
} {
  const sampleCount = size * size;
  const bestDistance = new Float32Array(sampleCount);
  bestDistance.fill(Number.POSITIVE_INFINITY);
  const bestFormationElevation = new Float32Array(sampleCount);

  const roadHalfWidth = config.roadWidth * 0.5;
  const formationHalfWidth = roadHalfWidth + config.shoulderWidth;
  const outerRadius = formationHalfWidth + config.blendWidth;

  for (let index = 0; index < nodes.length; index++) {
    const first = nodes[index];
    const second = nodes[(index + 1) % nodes.length];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 1e-12) continue;

    const length = Math.sqrt(lengthSquared);
    const normalX = -dy / length;
    const normalY = dx / length;
    const minimumColumn = clampInt(
      Math.floor((Math.min(first.x, second.x) - outerRadius) / squareSize),
      0,
      size - 1,
    );
    const maximumColumn = clampInt(
      Math.ceil((Math.max(first.x, second.x) + outerRadius) / squareSize),
      0,
      size - 1,
    );
    const minimumLocalRow = clampInt(
      Math.floor((Math.min(first.y, second.y) - outerRadius) / squareSize),
      0,
      size - 1,
    );
    const maximumLocalRow = clampInt(
      Math.ceil((Math.max(first.y, second.y) + outerRadius) / squareSize),
      0,
      size - 1,
    );

    for (let localRow = minimumLocalRow; localRow <= maximumLocalRow; localRow++) {
      const y = localRow * squareSize;
      const rasterRow = size - 1 - localRow;
      for (let column = minimumColumn; column <= maximumColumn; column++) {
        const x = column * squareSize;
        const projection = clamp(
          ((x - first.x) * dx + (y - first.y) * dy) / lengthSquared,
          0,
          1,
        );
        const projectedX = first.x + projection * dx;
        const projectedY = first.y + projection * dy;
        const offsetX = x - projectedX;
        const offsetY = y - projectedY;
        const distance = Math.hypot(offsetX, offsetY);
        if (distance > outerRadius) continue;

        const sampleIndex = rasterRow * size + column;
        if (distance >= bestDistance[sampleIndex]) continue;

        const signedOffset = offsetX * normalX + offsetY * normalY;
        const centerElevation = lerp(first.z, second.z, projection);
        const bank = lerp(first.bank, second.bank, projection);
        bestDistance[sampleIndex] = distance;
        bestFormationElevation[sampleIndex] = centerElevation + signedOffset * bank;
      }
    }
  }

  const elevations = new Float32Array(original);
  const layerMap = new Uint8Array(originalLayerMap);
  let minimumCutFill = Number.POSITIVE_INFINITY;
  let maximumCutFill = Number.NEGATIVE_INFINITY;
  let modifiedSampleCount = 0;
  let asphaltSampleCount = 0;

  for (let index = 0; index < sampleCount; index++) {
    const distance = bestDistance[index];
    if (!Number.isFinite(distance) || distance > outerRadius) continue;

    const blend = distance <= formationHalfWidth
      ? 1
      : 1 - smoothstep(formationHalfWidth, outerRadius, distance);
    const finalElevation = lerp(original[index], bestFormationElevation[index], blend);
    const cutFill = finalElevation - original[index];
    elevations[index] = finalElevation;
    minimumCutFill = Math.min(minimumCutFill, cutFill);
    maximumCutFill = Math.max(maximumCutFill, cutFill);
    modifiedSampleCount++;

    if (distance <= roadHalfWidth) {
      layerMap[index] = 1;
      asphaltSampleCount++;
    }
  }

  if (modifiedSampleCount === 0 || asphaltSampleCount === 0) {
    throw new Error('Final road corridor did not reach the native terrain grid');
  }

  return {
    elevations,
    layerMap,
    minimumCutFill,
    maximumCutFill,
    modifiedSampleCount,
    asphaltSampleCount,
  };
}

function createRoadSpawn(
  first: RoadTerrainNode,
  second: RoadTerrainNode,
): Record<string, unknown> {
  const heading = Math.atan2(second.y - first.y, second.x - first.x);
  const rotation = heading - Math.PI / 2;
  const cosine = round(Math.cos(rotation), 9);
  const sine = round(Math.sin(rotation), 9);
  return {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [first.x, first.y, round(first.z + 1.5, 6)],
    rotationMatrix: [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
    description: 'TriWorld V4 road-aligned mountain circuit spawn',
  };
}

function calculateMaximumGrade(
  nodes: readonly RoadTerrainNode[],
  segmentLengths: Float64Array,
): number {
  return calculateMaximumGradeFromElevations(
    Float64Array.from(nodes, (node) => node.z),
    segmentLengths,
  );
}

function calculateMaximumGradeFromElevations(
  elevations: Float64Array,
  segmentLengths: Float64Array,
): number {
  let maximum = 0;
  for (let index = 0; index < elevations.length; index++) {
    const next = (index + 1) % elevations.length;
    maximum = Math.max(
      maximum,
      Math.abs(elevations[next] - elevations[index]) / segmentLengths[index],
    );
  }
  return maximum;
}

function sampleGridBilinear(
  values: Float32Array,
  size: number,
  squareSize: number,
  xMetres: number,
  yMetres: number,
): number {
  const gridX = clamp(xMetres / squareSize, 0, size - 1);
  const localGridY = clamp(yMetres / squareSize, 0, size - 1);
  const rasterY = size - 1 - localGridY;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(rasterY);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = gridX - x0;
  const ty = rasterY - y0;
  const z00 = values[y0 * size + x0];
  const z10 = values[y0 * size + x1];
  const z01 = values[y1 * size + x0];
  const z11 = values[y1 * size + x1];
  return lerp(lerp(z00, z10, tx), lerp(z01, z11, tx), ty);
}

function quantizeElevations(elevations: Float32Array, heightScale: number): Uint16Array {
  const quantized = new Uint16Array(elevations.length);
  for (let index = 0; index < elevations.length; index++) {
    quantized[index] = clampInt(Math.round(elevations[index] / heightScale), 0, 65535);
  }
  return quantized;
}

function scanDecodedBounds(
  values: Uint16Array,
  heightScale: number,
): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const decoded = value * heightScale;
    minimum = Math.min(minimum, decoded);
    maximum = Math.max(maximum, decoded);
  }
  return { minimum, maximum };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const ratio = clamp((value - edge0) / Math.max(1e-12, edge1 - edge0), 0, 1);
  return ratio * ratio * (3 - 2 * ratio);
}

function lerp(first: number, second: number, ratio: number): number {
  return first + (second - first) * ratio;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}
