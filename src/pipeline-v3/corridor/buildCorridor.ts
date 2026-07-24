import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { DesignedSumoStation } from '../sumo/SumoGeometryV3';
import { solveDaylightRayV3, type DaylightPolicyV3 } from '../civil/daylightSolver';
import { createCorridorVertex, fixedPointKey, type CorridorVertex } from './CorridorVertex';
import { validateQuadV3, doFixedDiagonalsIntersectInternally, type CorridorQuadV3 } from './validateQuad';
import { triangulateQuadV3, type TriangleV3 } from './triangulateQuad';

export interface StationCrossSectionV3 {
  stationIndex: number;
  stationMm: number;
  isFeasible: boolean;
  centerVertex: CorridorVertex;
  formationLeftVertex: CorridorVertex;
  formationRightVertex: CorridorVertex;
  daylightLeftVertex: CorridorVertex;
  daylightRightVertex: CorridorVertex;
  leftMode: string;
  rightMode: string;
}

export interface CorridorResultV3 {
  crossSections: StationCrossSectionV3[];
  quads: CorridorQuadV3[];
  triangles: TriangleV3[];
}

export function buildCorridorV3(
  stations: readonly DesignedSumoStation[],
  grid: TerrainGridV3,
  edgeKey: string,
  laneHalfWidth: number = 1.75,
  shoulderWidth: number = 1.0,
  safetyGridZoneMetres: number = 1.5,
  policy?: DaylightPolicyV3,
): CorridorResultV3 {
  if (stations.length < 2) {
    return { crossSections: [], quads: [], triangles: [] };
  }

  const formationHalfWidth = laneHalfWidth + shoulderWidth;
  // Rasterize a flat formation safety zone beyond the physical shoulder so
  // bilinear TerrainBlock sampling never blends shoulder vertices with
  // untouched ground. Daylight slopes begin at this same outer boundary.
  const formationRasterHalfWidth = formationHalfWidth + safetyGridZoneMetres;

  // Determine canonical Side A vs Side B ONCE for the entire lane based on station 0
  const st0 = stations[0];
  const fLeftX0 = st0.x + st0.normalX * formationRasterHalfWidth;
  const fLeftY0 = st0.y + st0.normalY * formationRasterHalfWidth;
  const fRightX0 = st0.x - st0.normalX * formationRasterHalfWidth;
  const fRightY0 = st0.y - st0.normalY * formationRasterHalfWidth;

  const fLeftKey0 = `${Math.round(fLeftX0 * 1000)}:${Math.round(fLeftY0 * 1000)}`;
  const fRightKey0 = `${Math.round(fRightX0 * 1000)}:${Math.round(fRightY0 * 1000)}`;

  const isLeftSideA = fLeftKey0 < fRightKey0;
  const leftSideTag = isLeftSideA ? 'sideA' : 'sideB';
  const rightSideTag = isLeftSideA ? 'sideB' : 'sideA';

  const crossSections: StationCrossSectionV3[] = [];

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const stationMm = Math.round(st.station * 1000);

    const fLeftX = st.x + st.normalX * formationRasterHalfWidth;
    const fLeftY = st.y + st.normalY * formationRasterHalfWidth;
    const fRightX = st.x - st.normalX * formationRasterHalfWidth;
    const fRightY = st.y - st.normalY * formationRasterHalfWidth;

    // Daylight slope starts at the outer edge of the safety grid zone.
    const daylightLeft = solveDaylightRayV3(st, formationRasterHalfWidth, true, grid, policy);
    const daylightRight = solveDaylightRayV3(st, formationRasterHalfWidth, false, grid, policy);

    const isFeasible = daylightLeft.mode !== 'infeasible' && daylightRight.mode !== 'infeasible';

    const centerVertex = createCorridorVertex(st.x, st.y, st.formationZ, `${edgeKey}:${stationMm}:center`, 'center');
    const formationLeftVertex = createCorridorVertex(fLeftX, fLeftY, st.formationZ, `${edgeKey}:${stationMm}:formation:${leftSideTag}`, 'formation-left');
    const formationRightVertex = createCorridorVertex(fRightX, fRightY, st.formationZ, `${edgeKey}:${stationMm}:formation:${rightSideTag}`, 'formation-right');

    const daylightLeftVertex = createCorridorVertex(
      isFeasible ? daylightLeft.x : fLeftX,
      isFeasible ? daylightLeft.y : fLeftY,
      isFeasible ? daylightLeft.z : st.formationZ,
      `${edgeKey}:${stationMm}:daylight:${leftSideTag}`,
      'daylight-left',
    );
    const daylightRightVertex = createCorridorVertex(
      isFeasible ? daylightRight.x : fRightX,
      isFeasible ? daylightRight.y : fRightY,
      isFeasible ? daylightRight.z : st.formationZ,
      `${edgeKey}:${stationMm}:daylight:${rightSideTag}`,
      'daylight-right',
    );

    crossSections.push({
      stationIndex: i,
      stationMm,
      isFeasible,
      centerVertex,
      formationLeftVertex,
      formationRightVertex,
      daylightLeftVertex,
      daylightRightVertex,
      leftMode: daylightLeft.mode,
      rightMode: daylightRight.mode,
    });
  }

  // Build 3 Quad Strips: Formation, Slope Left, Slope Right
  const quads: CorridorQuadV3[] = [];
  const triangles: TriangleV3[] = [];
  let primitiveRankCounter = 0;

  for (let i = 0; i < crossSections.length - 1; i++) {
    const cs0 = crossSections[i];
    const cs1 = crossSections[i + 1];
    const segmentRank = i;

    // Skip building quads if either station is infeasible (out of bounds or earthwork limit)
    if (!cs0.isFeasible || !cs1.isFeasible) {
      continue;
    }

    // 1. Formation Quad (left0, left1, right1, right0 in CCW order)
    const quadFormation = buildCanonicalQuad(
      `${edgeKey}:seg-${i}:formation`,
      segmentRank,
      'formation',
      cs0.formationLeftVertex,
      cs1.formationLeftVertex,
      cs1.formationRightVertex,
      cs0.formationRightVertex,
    );

    const candidateQuads: CorridorQuadV3[] = [];

    if (doFixedDiagonalsIntersectInternally(quadFormation.v0, quadFormation.v1, quadFormation.v2, quadFormation.v3)) {
      candidateQuads.push(quadFormation);
    } else {
      // At sharp bend miter cross, emit two clean fan triangles using center vertex
      const t0 = createCCWTriangle(
        `${edgeKey}:seg-${i}:formation-fan0`,
        quadFormation.quadId,
        segmentRank,
        primitiveRankCounter++,
        'formation',
        cs0.centerVertex,
        cs0.formationLeftVertex,
        cs1.formationLeftVertex,
      );
      const t1 = createCCWTriangle(
        `${edgeKey}:seg-${i}:formation-fan1`,
        quadFormation.quadId,
        segmentRank,
        primitiveRankCounter++,
        'formation',
        cs0.centerVertex,
        cs1.formationRightVertex,
        cs0.formationRightVertex,
      );
      triangles.push(t0, t1);
    }

    // 2. Slope Left Quad
    const keysLeft = new Set([
      fixedPointKey(cs0.daylightLeftVertex),
      fixedPointKey(cs1.daylightLeftVertex),
      fixedPointKey(cs1.formationLeftVertex),
      fixedPointKey(cs0.formationLeftVertex),
    ]);
    if (keysLeft.size === 4) {
      const q = buildCanonicalQuad(
        `${edgeKey}:seg-${i}:slope-sideA`,
        segmentRank,
        'slope-side-a',
        cs0.daylightLeftVertex,
        cs1.daylightLeftVertex,
        cs1.formationLeftVertex,
        cs0.formationLeftVertex,
      );
      if (doFixedDiagonalsIntersectInternally(q.v0, q.v1, q.v2, q.v3)) {
        candidateQuads.push(q);
      }
    }

    // 3. Slope Right Quad
    const keysRight = new Set([
      fixedPointKey(cs0.formationRightVertex),
      fixedPointKey(cs1.formationRightVertex),
      fixedPointKey(cs1.daylightRightVertex),
      fixedPointKey(cs0.daylightRightVertex),
    ]);
    if (keysRight.size === 4) {
      const q = buildCanonicalQuad(
        `${edgeKey}:seg-${i}:slope-sideB`,
        segmentRank,
        'slope-side-b',
        cs0.formationRightVertex,
        cs1.formationRightVertex,
        cs1.daylightRightVertex,
        cs0.daylightRightVertex,
      );
      if (doFixedDiagonalsIntersectInternally(q.v0, q.v1, q.v2, q.v3)) {
        candidateQuads.push(q);
      }
    }

    for (const q of candidateQuads) {
      validateQuadV3(q);
      quads.push(q);

      const tris = triangulateQuadV3(q, primitiveRankCounter);
      primitiveRankCounter += tris.length;
      triangles.push(...tris);
    }
  }

  return { crossSections, quads, triangles };
}

function createCCWTriangle(
  primitiveId: string,
  quadId: string,
  segmentRank: number,
  primitiveRank: number,
  role: 'formation' | 'slope-side-a' | 'slope-side-b',
  v0: CorridorVertex,
  v1: CorridorVertex,
  v2: CorridorVertex,
): TriangleV3 {
  const p0 = { x: BigInt(v0.fixedX), y: BigInt(v0.fixedY) };
  const p1 = { x: BigInt(v1.fixedX), y: BigInt(v1.fixedY) };
  const p2 = { x: BigInt(v2.fixedX), y: BigInt(v2.fixedY) };

  const area2 = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);

  let finalV1 = v1;
  let finalV2 = v2;
  if (area2 < 0n) {
    finalV1 = v2;
    finalV2 = v1;
  }

  const chosenDiagonalKey = canonicalPairKey(v0.stableVertexId, finalV2.stableVertexId);

  return {
    primitiveId,
    quadId,
    segmentRank,
    primitiveRank,
    role,
    v0,
    v1: finalV1,
    v2: finalV2,
    chosenDiagonalKey,
  };
}

function canonicalPairKey(id1: string, id2: string): string {
  return id1 < id2 ? `${id1}<->${id2}` : `${id2}<->${id1}`;
}

function buildCanonicalQuad(
  quadId: string,
  segmentRank: number,
  role: CorridorQuadV3['role'],
  a: CorridorVertex,
  b: CorridorVertex,
  c: CorridorVertex,
  d: CorridorVertex,
): CorridorQuadV3 {
  let raw: [CorridorVertex, CorridorVertex, CorridorVertex, CorridorVertex] = [a, b, c, d];

  const area = computeFixedArea(raw);
  if (area < 0) {
    raw = [a, d, c, b];
  }

  let minIdx = 0;
  for (let k = 1; k < 4; k++) {
    if (raw[k].stableVertexId < raw[minIdx].stableVertexId) {
      minIdx = k;
    }
  }

  const v0 = raw[minIdx];
  const v1 = raw[(minIdx + 1) % 4];
  const v2 = raw[(minIdx + 2) % 4];
  const v3 = raw[(minIdx + 3) % 4];

  return {
    quadId,
    segmentRank,
    role,
    v0,
    v1,
    v2,
    v3,
  };
}

function computeFixedArea(verts: readonly CorridorVertex[]): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = verts[i];
    const p1 = verts[(i + 1) % 4];
    sum += (p1.fixedX - p0.fixedX) * (p1.fixedY + p0.fixedY);
  }
  return -sum / 2;
}
