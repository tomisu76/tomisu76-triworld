import type { GeodeticTransformer, UtmPoint } from './geodetic-transformer';
import {
  DRIVEABLE_HIGHWAY_TYPES,
  type OsmWayMetadata,
  type RawSumoEdge,
  type SitecheckOverlayPoint,
} from './sitecheck-sumo-overlay-types';

export interface ParsedNamedSumoEdges {
  netOffsetX: number;
  netOffsetY: number;
  projection: string;
  edges: RawSumoEdge[];
}

export function parseNamedOsmWays(
  osmXml: string,
  expectedRoadNames: readonly string[],
): Map<string, OsmWayMetadata> {
  const expectedByNormalizedName = new Map(
    expectedRoadNames.map((name) => [normalizeName(name), name]),
  );
  const result = new Map<string, OsmWayMetadata>();
  const wayRegex = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  let match: RegExpExecArray | null;

  while ((match = wayRegex.exec(osmXml)) !== null) {
    const wayId = readXmlAttribute(match[1], 'id');
    if (!wayId) continue;

    const nameRaw = parseTag(match[2], 'name');
    if (!nameRaw) continue;

    const canonicalName = expectedByNormalizedName.get(normalizeName(nameRaw));
    if (!canonicalName) continue;

    const highway = parseTag(match[2], 'highway') ?? '';
    if (!DRIVEABLE_HIGHWAY_TYPES.has(highway)) continue;

    result.set(wayId, {
      wayId,
      name: canonicalName,
      highway,
      widthMetres: parseRoadWidth({
        width: parseTag(match[2], 'width'),
        lanes: parseTag(match[2], 'lanes'),
        highway,
      }),
    });
  }

  for (const expectedName of expectedRoadNames) {
    if (![...result.values()].some(
      (way) => normalizeName(way.name) === normalizeName(expectedName),
    )) {
      throw new Error(`OSM contains no driveable named way for '${expectedName}'.`);
    }
  }

  return result;
}

export function parseNamedSumoEdges(
  netXml: string,
  osmWays: ReadonlyMap<string, OsmWayMetadata>,
  transformer: GeodeticTransformer,
  localSampleOffsetMetres: number,
  clippingMinimum: number,
  clippingMaximum: number,
): ParsedNamedSumoEdges {
  const locationTag = netXml.match(/<location\b([^>]*?)\/>/)?.[1];
  if (!locationTag) {
    throw new Error('SITECHECK01 SUMO network is missing the <location> element.');
  }

  const netOffsetRaw = readXmlAttribute(locationTag, 'netOffset');
  const projection = readXmlAttribute(locationTag, 'projParameter');
  if (!netOffsetRaw || !projection) {
    throw new Error('SITECHECK01 SUMO location is missing netOffset or projParameter.');
  }
  if (!projection.includes('+proj=utm') || !projection.includes('+zone=34')) {
    throw new Error(`Unsupported SITECHECK01 SUMO projection: ${projection}`);
  }

  const [netOffsetX, netOffsetY] = parseCoordinatePair(netOffsetRaw, 'netOffset');
  const result: RawSumoEdge[] = [];
  const edgeRegex = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/g;
  let match: RegExpExecArray | null;

  while ((match = edgeRegex.exec(netXml)) !== null) {
    const attributes = match[1];
    const edgeId = readXmlAttribute(attributes, 'id');
    if (!edgeId || edgeId.startsWith(':')) continue;
    if (readXmlAttribute(attributes, 'function') === 'internal') continue;

    const unsignedEdgeId = edgeId.startsWith('-') ? edgeId.slice(1) : edgeId;
    const osmWayId = unsignedEdgeId.split('#')[0];
    const metadata = osmWays.get(osmWayId);
    if (!metadata) continue;

    const type = readXmlAttribute(attributes, 'type') ?? '';
    const sumoHighway = type.startsWith('highway.') ? type.slice('highway.'.length) : '';
    if (sumoHighway && !DRIVEABLE_HIGHWAY_TYPES.has(sumoHighway)) continue;

    const fromNodeId = readXmlAttribute(attributes, 'from');
    const toNodeId = readXmlAttribute(attributes, 'to');
    if (!fromNodeId || !toNodeId) {
      throw new Error(`SUMO edge ${edgeId} is missing from/to topology.`);
    }

    const shape = readXmlAttribute(attributes, 'shape') ?? firstLaneShape(match[2]);
    if (!shape) {
      throw new Error(`SUMO edge ${edgeId} is missing edge and lane shape geometry.`);
    }

    const pointsUnclipped = parsePointList(shape, `edge ${edgeId}`).map((point) => {
      const utm: UtmPoint = {
        easting: point.x - netOffsetX,
        northing: point.y - netOffsetY,
        elevation: 0,
        zone: 34,
      };
      const local = transformer.utmToLocal(utm);
      return {
        x: local.x - localSampleOffsetMetres,
        y: local.y - localSampleOffsetMetres,
      };
    });

    const fragments = clipPolylineToBounds(
      pointsUnclipped,
      clippingMinimum,
      clippingMaximum,
    );

    for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
      const points = removeConsecutiveDuplicates(fragments[fragmentIndex]);
      if (points.length < 2) continue;

      const firstWasClipped = distance(points[0], pointsUnclipped[0]) > 0.05;
      const lastWasClipped = distance(
        points[points.length - 1],
        pointsUnclipped[pointsUnclipped.length - 1],
      ) > 0.05;

      result.push({
        edgeId: fragments.length === 1 ? edgeId : `${edgeId}:fragment:${fragmentIndex}`,
        segmentKey: fragments.length === 1
          ? unsignedEdgeId
          : `${unsignedEdgeId}:fragment:${fragmentIndex}`,
        osmWayId,
        name: metadata.name,
        highway: metadata.highway,
        widthMetres: metadata.widthMetres,
        fromNodeId: firstWasClipped
          ? `${edgeId}:clip:${fragmentIndex}:start`
          : fromNodeId,
        toNodeId: lastWasClipped
          ? `${edgeId}:clip:${fragmentIndex}:end`
          : toNodeId,
        points,
        lengthMetres: polylineLength(points),
      });
    }
  }

  return {
    netOffsetX,
    netOffsetY,
    projection,
    edges: result,
  };
}

function clipPolylineToBounds(
  points: readonly SitecheckOverlayPoint[],
  minimum: number,
  maximum: number,
): SitecheckOverlayPoint[][] {
  const fragments: SitecheckOverlayPoint[][] = [];
  let current: SitecheckOverlayPoint[] = [];

  const finish = (): void => {
    if (current.length >= 2) fragments.push(current);
    current = [];
  };

  for (let index = 1; index < points.length; index += 1) {
    const clipped = clipSegment(points[index - 1], points[index], minimum, maximum);
    if (!clipped) {
      finish();
      continue;
    }

    const [start, end] = clipped;
    const last = current[current.length - 1];

    if (!last) {
      current.push(start, end);
    } else if (distance(last, start) <= 0.10) {
      if (distance(last, end) > 0.02) current.push(end);
    } else {
      finish();
      current.push(start, end);
    }
  }

  finish();
  return fragments;
}

function clipSegment(
  start: SitecheckOverlayPoint,
  end: SitecheckOverlayPoint,
  minimum: number,
  maximum: number,
): [SitecheckOverlayPoint, SitecheckOverlayPoint] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t0 = 0;
  let t1 = 1;

  const tests: Array<[number, number]> = [
    [-dx, start.x - minimum],
    [dx, maximum - start.x],
    [-dy, start.y - minimum],
    [dy, maximum - start.y],
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) return null;
      if (ratio > t0) t0 = ratio;
    } else {
      if (ratio < t0) return null;
      if (ratio < t1) t1 = ratio;
    }
  }

  return [
    { x: start.x + t0 * dx, y: start.y + t0 * dy },
    { x: start.x + t1 * dx, y: start.y + t1 * dy },
  ];
}

function parseTag(block: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = block.match(new RegExp(`<tag\\s+k="${escaped}"\\s+v="([^"]*)"\\s*\\/>`));
  if (first) return decodeXmlEntities(first[1]);
  const second = block.match(new RegExp(`<tag\\s+v="([^"]*)"\\s+k="${escaped}"\\s*\\/>`));
  return second ? decodeXmlEntities(second[1]) : undefined;
}

function firstLaneShape(edgeBody: string): string | undefined {
  const laneTag = edgeBody.match(/<lane\b([^>]*?)\/>/)?.[1];
  return laneTag ? readXmlAttribute(laneTag, 'shape') : undefined;
}

function readXmlAttribute(attributes: string, attribute: string): string | undefined {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return attributes.match(new RegExp(`\\b${escaped}="([^"]+)"`))?.[1];
}

function parsePointList(raw: string, label: string): SitecheckOverlayPoint[] {
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

function parseRoadWidth(tags: { width?: string; lanes?: string; highway: string }): number {
  const explicit = Number.parseFloat((tags.width ?? '').replace(',', '.'));
  if (Number.isFinite(explicit) && explicit > 1) return Math.min(20, explicit);

  const lanes = Number.parseFloat(tags.lanes ?? '');
  if (Number.isFinite(lanes) && lanes > 0) {
    return Math.min(20, Math.max(4.5, lanes * 3.15));
  }

  const defaults: Record<string, number> = {
    motorway: 12,
    trunk: 10,
    primary: 9,
    secondary: 8,
    tertiary: 7,
    residential: 6,
    unclassified: 5.5,
    living_street: 5,
  };
  return defaults[tags.highway] ?? 6;
}

function removeConsecutiveDuplicates(
  points: readonly SitecheckOverlayPoint[],
): SitecheckOverlayPoint[] {
  const result: SitecheckOverlayPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distance(previous, point) >= 0.02) {
      result.push(point);
    }
  }
  return result;
}

function polylineLength(points: readonly SitecheckOverlayPoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

function distance(a: SitecheckOverlayPoint, b: SitecheckOverlayPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
