import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { CanonicalSumoShapeResult } from '../sumo/SumoGeometryV3';
import type { CorridorResultV3 } from '../corridor/buildCorridor';
import type { TransactionResultV3 } from '../raster/corridorTransaction';

export interface PipelineFingerprintsV3 {
  sourceTerrainHash: string;
  canonicalShapeHash: string;
  stationsHash: string;
  roadBoundariesHash: string;
  formationBoundariesHash: string;
  daylightPointsHash: string;
  corridorVerticesHash: string;
  quadsHash: string;
  selectedDiagonalsHash: string;
  primitiveIdentitiesHash: string;
  coverageHash: string;
  targetZHash: string;
  workingTerrainHash: string;
}

export function computePipelineFingerprintsV3(
  grid: TerrainGridV3,
  sumoResult: CanonicalSumoShapeResult,
  corridorResult: CorridorResultV3,
  txResult: TransactionResultV3,
): PipelineFingerprintsV3 {
  const sourceTerrainHash = simpleArrayHash(grid.getSourceElevationArray());
  const canonicalShapeHash = simpleJsonHash(sumoResult.canonicalShape);

  const stationsHash = simpleJsonHash(
    corridorResult.crossSections.map((cs) => ({
      stationMm: cs.stationMm,
      x: Math.round(cs.centerVertex.x * 1000),
      y: Math.round(cs.centerVertex.y * 1000),
    })),
  );

  const roadBoundariesHash = simpleJsonHash(
    corridorResult.crossSections.map((cs) => ({
      formLeft: cs.formationLeftVertex.stableVertexId,
      formRight: cs.formationRightVertex.stableVertexId,
    })),
  );

  const formationBoundariesHash = roadBoundariesHash;

  const daylightPointsHash = simpleJsonHash(
    corridorResult.crossSections.map((cs) => ({
      dayLeft: cs.daylightLeftVertex.stableVertexId,
      dayRight: cs.daylightRightVertex.stableVertexId,
    })),
  );

  const corridorVerticesHash = simpleJsonHash(
    corridorResult.crossSections.flatMap((cs) => [
      cs.centerVertex.stableVertexId,
      cs.formationLeftVertex.stableVertexId,
      cs.formationRightVertex.stableVertexId,
      cs.daylightLeftVertex.stableVertexId,
      cs.daylightRightVertex.stableVertexId,
    ]),
  );

  const quadsHash = simpleJsonHash(
    corridorResult.quads.map((q) => ({
      quadId: q.quadId,
      v0: q.v0.stableVertexId,
      v1: q.v1.stableVertexId,
      v2: q.v2.stableVertexId,
      v3: q.v3.stableVertexId,
    })),
  );

  const selectedDiagonalsHash = simpleJsonHash(
    corridorResult.triangles.map((t) => ({
      primitiveId: t.primitiveId,
      diagKey: t.chosenDiagonalKey,
    })),
  );

  const primitiveIdentitiesHash = simpleJsonHash(
    corridorResult.triangles.map((t) => t.primitiveId),
  );

  const coverageHash = txResult.buffers
    ? simpleArrayHash(txResult.buffers.priority)
    : 'none';

  const targetZHash = txResult.buffers
    ? simpleFloatArrayHash(txResult.buffers.targetZ)
    : 'none';

  const workingTerrainHash = simpleFloatArrayHash(grid.workingElevations);

  return {
    sourceTerrainHash,
    canonicalShapeHash,
    stationsHash,
    roadBoundariesHash,
    formationBoundariesHash,
    daylightPointsHash,
    corridorVerticesHash,
    quadsHash,
    selectedDiagonalsHash,
    primitiveIdentitiesHash,
    coverageHash,
    targetZHash,
    workingTerrainHash,
  };
}

function simpleArrayHash(arr: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    hash ^= arr[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function simpleFloatArrayHash(arr: Float32Array): string {
  const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return simpleArrayHash(view);
}

function simpleJsonHash(obj: unknown): string {
  const json = JSON.stringify(obj);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
