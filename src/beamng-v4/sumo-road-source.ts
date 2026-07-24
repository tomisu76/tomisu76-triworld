import { createHash } from 'node:crypto';
import { clipRoadWayToBoundsV2 } from '../pipeline-v2/roads/road-clip-v2';
import type { Vec2 } from '../pipeline-v3/sumo/SumoGeometryV3';
import type { GeodeticTransformer, UtmPoint } from './geodetic-transformer';

export interface SumoNetLocation {
  netOffsetX: number;
  netOffsetY: number;
  projection: string;
}

export interface SumoRoadLane {
  laneId: string;
  width: number;
  points: Vec2[];
}

export interface SumoRoadEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  points: Vec2[];
  lanes: SumoRoadLane[];
}

export interface AuthoritativeSumoRoadAlignment {
  sourceType: 'sumo-netconvert-edge-centerline';
  osmWayId: number;
  allEdgeIds: string[];
  allLaneIds: string[];
  usedEdgeIds: string[];
  usedLaneIds: string[];
  pointsCentered: Vec2[];
  pointCount: number;
  lengthMetres: number;
  minimumDistanceToCentreMetres: number;
  boundsCentered: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  netOffset: {
    x: number;
    y: number;
  };
  sha256: string;
}

interface ParsedSumoRoadNetwork {
  location: SumoNetLocation;
  edges: SumoRoadEdge[];
}

type LocalTransformer = Pick<GeodeticTransformer, 'origin' | 'utmToLocal'>;

export function parseAuthoritativeSumoRoadNetwork(
  netXml: string,
  osmWayId: number,
): ParsedSumoRoadNetwork {
  const locationTag = netXml.match(/<location\b([^>]*?)\/>/)?.[1];
  if (!locationTag) {
    throw new Error('SUMO network is missing the <location> element.');
  }

  const netOffsetRaw = readXmlAttribute(locationTag, 'netOffset');
  const projection = readXmlAttribute(locationTag, 'projParameter');
  if (!netOffsetRaw || !projection) {
    throw new Error('SUMO network location is missing netOffset or projParameter.');
  }

  const [netOffsetX, netOffsetY] = parseCoordinatePair(netOffsetRaw, 'netOffset');
  if (!projection.includes('+proj=utm') || !projection.includes('+zone=34')) {
    throw new Error(`Unsupported SUMO projection: ${projection}`);
  }

  const expectedIds = new Set([
    `-${osmWayId}#0`,
    `-${osmWayId}#1`,
    `${osmWayId}#0`,
    `${osmWayId}#1`,
  ]);
  const edges: SumoRoadEdge[] = [];
  const edgeRegex = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/g;
  let edgeMatch: RegExpExecArray | null;

  while ((edgeMatch = edgeRegex.exec(netXml)) !== null) {
    const edgeAttributes = edgeMatch[1];
    const edgeId = readXmlAttribute(edgeAttributes, 'id');
    if (!edgeId || !expectedIds.has(edgeId)) continue;

    const fromNodeId = readXmlAttribute(edgeAttributes, 'from');
    const toNodeId = readXmlAttribute(edgeAttributes, 'to');
    const edgeShape = readXmlAttribute(edgeAttributes, 'shape');
    if (!fromNodeId || !toNodeId || !edgeShape) {
      throw new Error(`SUMO edge ${edgeId} is missing from, to, or shape.`);
    }

    const lanes: SumoRoadLane[] = [];
    const laneRegex = /<lane\b([^>]*?)\/>/g;
    let laneMatch: RegExpExecArray | null;
    while ((laneMatch = laneRegex.exec(edgeMatch[2])) !== null) {
      const laneAttributes = laneMatch[1];
      const laneId = readXmlAttribute(laneAttributes, 'id');
      const laneShape = readXmlAttribute(laneAttributes, 'shape');
      if (!laneId || !laneShape) continue;

      const width = Number(readXmlAttribute(laneAttributes, 'width') ?? 3.2);
      if (!Number.isFinite(width) || width <= 0) {
        throw new Error(`SUMO lane ${laneId} has invalid width ${width}.`);
      }
      lanes.push({
        laneId,
        width,
        points: parsePointList(laneShape, `lane ${laneId}`),
      });
    }

    if (lanes.length !== 1) {
      throw new Error(`Expected exactly one lane on SUMO edge ${edgeId}, received ${lanes.length}.`);
    }

    edges.push({
      edgeId,
      fromNodeId,
      toNodeId,
      points: parsePointList(edgeShape, `edge ${edgeId}`),
      lanes,
    });
  }

  if (edges.length !== expectedIds.size) {
    const found = new Set(edges.map((edge) => edge.edgeId));
    const missing = [...expectedIds].filter((edgeId) => !found.has(edgeId));
    throw new Error(
      `Authoritative SUMO mapping incomplete for OSM way ${osmWayId}: ` +
      `expected ${expectedIds.size} edges, received ${edges.length}; missing ${missing.join(', ')}.`,
    );
  }

  return {
    location: { netOffsetX, netOffsetY, projection },
    edges,
  };
}

export function resolveAuthoritativeSumoRoadAlignment(
  netXml: string,
  transformer: LocalTransformer,
  osmWayId: number,
  roadWidthMetres: number,
  minimumInsetMetres: number = 12,
  minimumLengthMetres: number = 80,
): AuthoritativeSumoRoadAlignment {
  if (!Number.isFinite(roadWidthMetres) || roadWidthMetres <= 0) {
    throw new RangeError(`roadWidthMetres must be finite and > 0, received ${roadWidthMetres}.`);
  }
  if (!Number.isFinite(minimumInsetMetres) || minimumInsetMetres < 0) {
    throw new RangeError(`minimumInsetMetres must be finite and >= 0, received ${minimumInsetMetres}.`);
  }

  const parsed = parseAuthoritativeSumoRoadNetwork(netXml, osmWayId);
  const forwardEdges = orderContinuousEdges(
    parsed.edges.filter((edge) => !edge.edgeId.startsWith('-')),
    'forward',
  );
  const reverseEdges = orderContinuousEdges(
    parsed.edges.filter((edge) => edge.edgeId.startsWith('-')),
    'reverse',
  );

  const forwardStart = forwardEdges[0].fromNodeId;
  const forwardEnd = forwardEdges[forwardEdges.length - 1].toNodeId;
  const reverseStart = reverseEdges[0].fromNodeId;
  const reverseEnd = reverseEdges[reverseEdges.length - 1].toNodeId;
  if (forwardStart !== reverseEnd || forwardEnd !== reverseStart) {
    throw new Error(
      `SUMO directional chains are not topological reverses: ` +
      `forward ${forwardStart}->${forwardEnd}, reverse ${reverseStart}->${reverseEnd}.`,
    );
  }

  const sumoCenterline = concatenateEdgePoints(forwardEdges);
  const halfExtent = transformer.origin.sizeMetres / 2;
  const centered = sumoCenterline.map((point) => {
    const utm: UtmPoint = {
      easting: point.x - parsed.location.netOffsetX,
      northing: point.y - parsed.location.netOffsetY,
      elevation: 0,
      zone: 34,
    };
    const local = transformer.utmToLocal(utm);
    return {
      x: local.x - halfExtent,
      y: local.y - halfExtent,
    };
  });

  const safeInset = Math.max(minimumInsetMetres, roadWidthMetres / 2 + 2);
  const safeHalfExtent = halfExtent - safeInset;
  if (safeHalfExtent <= 0) {
    throw new RangeError(
      `SUMO road inset ${safeInset}m leaves no valid domain in a ${transformer.origin.sizeMetres}m terrain.`,
    );
  }

  const fragments = clipRoadWayToBoundsV2(centered, safeHalfExtent)
    .map(removeConsecutiveDuplicates)
    .filter((fragment) => fragment.length >= 2)
    .map((points) => ({ points, lengthMetres: polylineLength(points) }))
    .sort((a, b) => b.lengthMetres - a.lengthMetres);
  const selected = fragments[0];
  if (!selected || selected.lengthMetres < minimumLengthMetres) {
    throw new Error(
      `No authoritative SUMO fragment of OSM way ${osmWayId} reaches ` +
      `${minimumLengthMetres}m inside the terrain.`,
    );
  }

  const boundsCentered = boundsOf(selected.points);
  const allEdgeIds = parsed.edges.map((edge) => edge.edgeId).sort();
  const allLaneIds = parsed.edges.flatMap((edge) => edge.lanes.map((lane) => lane.laneId)).sort();
  const usedEdgeIds = forwardEdges.map((edge) => edge.edgeId);
  const usedLaneIds = forwardEdges.flatMap((edge) => edge.lanes.map((lane) => lane.laneId));
  const normalized = {
    osmWayId,
    netOffsetX: roundMillimetres(parsed.location.netOffsetX),
    netOffsetY: roundMillimetres(parsed.location.netOffsetY),
    usedEdgeIds,
    usedLaneIds,
    pointsCentered: selected.points.map((point) => ({
      x: roundMillimetres(point.x),
      y: roundMillimetres(point.y),
    })),
  };

  return {
    sourceType: 'sumo-netconvert-edge-centerline',
    osmWayId,
    allEdgeIds,
    allLaneIds,
    usedEdgeIds,
    usedLaneIds,
    pointsCentered: selected.points,
    pointCount: selected.points.length,
    lengthMetres: selected.lengthMetres,
    minimumDistanceToCentreMetres: minimumDistanceToPolyline({ x: 0, y: 0 }, selected.points),
    boundsCentered,
    netOffset: {
      x: parsed.location.netOffsetX,
      y: parsed.location.netOffsetY,
    },
    sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

function orderContinuousEdges(edges: readonly SumoRoadEdge[], label: string): SumoRoadEdge[] {
  if (edges.length === 0) {
    throw new Error(`SUMO ${label} directional chain is empty.`);
  }

  const destinationNodes = new Set(edges.map((edge) => edge.toNodeId));
  const starts = edges.filter((edge) => !destinationNodes.has(edge.fromNodeId));
  if (starts.length !== 1) {
    throw new Error(
      `SUMO ${label} directional chain must have exactly one start edge, received ${starts.length}.`,
    );
  }

  const ordered: SumoRoadEdge[] = [];
  const unused = new Map(edges.map((edge) => [edge.edgeId, edge]));
  let current: SumoRoadEdge | undefined = starts[0];
  while (current) {
    ordered.push(current);
    unused.delete(current.edgeId);
    const next = [...unused.values()].filter((edge) => edge.fromNodeId === current!.toNodeId);
    if (next.length > 1) {
      throw new Error(
        `SUMO ${label} directional chain branches at node ${current.toNodeId}.`,
      );
    }
    current = next[0];
  }

  if (unused.size !== 0) {
    throw new Error(
      `SUMO ${label} directional chain is disconnected; unused edges: ${[...unused.keys()].join(', ')}.`,
    );
  }
  return ordered;
}

function concatenateEdgePoints(edges: readonly SumoRoadEdge[]): Vec2[] {
  const result: Vec2[] = [];
  for (const edge of edges) {
    for (const point of edge.points) {
      const previous = result[result.length - 1];
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.02) {
        result.push({ x: point.x, y: point.y });
      }
    }
  }
  if (result.length < 2) {
    throw new Error('SUMO edge chain produced fewer than two centerline points.');
  }
  return result;
}

function parsePointList(raw: string, label: string): Vec2[] {
  const points = raw.trim().split(/\s+/).map((pair) => {
    const [xRaw, yRaw] = pair.split(',');
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinate '${pair}' in SUMO ${label}.`);
    }
    return { x, y };
  });
  if (points.length < 2) {
    throw new Error(`SUMO ${label} contains fewer than two points.`);
  }
  return points;
}

function parseCoordinatePair(raw: string, label: string): [number, number] {
  const [xRaw, yRaw] = raw.split(',');
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid SUMO ${label} '${raw}'.`);
  }
  return [x, y];
}

function readXmlAttribute(tag: string, attribute: string): string | undefined {
  return tag.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1];
}

function removeConsecutiveDuplicates(points: readonly Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.02) {
      result.push({ x: point.x, y: point.y });
    }
  }
  return result;
}

function polylineLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function boundsOf(points: readonly Vec2[]): AuthoritativeSumoRoadAlignment['boundsCentered'] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function minimumDistanceToPolyline(point: Vec2, polyline: readonly Vec2[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polyline.length - 1; index++) {
    minimum = Math.min(minimum, distanceToSegment(point, polyline[index], polyline[index + 1]));
  }
  return minimum;
}

function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function roundMillimetres(value: number): number {
  return Math.round(value * 1000) / 1000;
}
