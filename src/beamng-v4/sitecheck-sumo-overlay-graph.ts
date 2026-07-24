import type {
  PrincipalComponent,
  RawSumoEdge,
  SitecheckOverlayPoint,
} from './sitecheck-sumo-overlay-types';

export function canonicalizeDirectionalEdges(
  edges: readonly RawSumoEdge[],
): RawSumoEdge[] {
  const bySegment = new Map<string, RawSumoEdge>();

  for (const edge of edges) {
    const existing = bySegment.get(edge.segmentKey);
    const currentIsForward = !edge.edgeId.startsWith('-');
    const existingIsForward = existing ? !existing.edgeId.startsWith('-') : false;

    if (!existing || (currentIsForward && !existingIsForward)) {
      bySegment.set(edge.segmentKey, currentIsForward ? edge : reverseEdge(edge));
    }
  }

  return [...bySegment.values()].sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}

export function connectedComponents(edges: readonly RawSumoEdge[]): RawSumoEdge[][] {
  const adjacency = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    appendMapArray(adjacency, edge.fromNodeId, index);
    appendMapArray(adjacency, edge.toNodeId, index);
  });

  const visited = new Set<number>();
  const result: RawSumoEdge[][] = [];

  for (let startIndex = 0; startIndex < edges.length; startIndex += 1) {
    if (visited.has(startIndex)) continue;

    const queue = [startIndex];
    const component: RawSumoEdge[] = [];
    visited.add(startIndex);

    while (queue.length > 0) {
      const edgeIndex = queue.shift()!;
      const edge = edges[edgeIndex];
      component.push(edge);

      for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
        for (const neighborIndex of adjacency.get(nodeId) ?? []) {
          if (!visited.has(neighborIndex)) {
            visited.add(neighborIndex);
            queue.push(neighborIndex);
          }
        }
      }
    }

    result.push(component);
  }

  return result;
}

export function buildPrincipalComponent(
  name: string,
  edges: readonly RawSumoEdge[],
  localCentre: number,
): PrincipalComponent {
  const adjacency = new Map<string, Array<{ edgeIndex: number; otherNodeId: string }>>();
  edges.forEach((edge, edgeIndex) => {
    appendMapArray(adjacency, edge.fromNodeId, { edgeIndex, otherNodeId: edge.toNodeId });
    appendMapArray(adjacency, edge.toNodeId, { edgeIndex, otherNodeId: edge.fromNodeId });
  });

  const nodes = [...adjacency.keys()];
  if (nodes.length < 2) {
    throw new Error(`SUMO component for '${name}' has fewer than two topology nodes.`);
  }

  let bestSource = nodes[0];
  let bestTarget = nodes[1];
  let bestDistance = Number.NEGATIVE_INFINITY;
  let bestParents = new Map<string, { previousNodeId: string; edgeIndex: number }>();

  for (const source of nodes) {
    const { distances, parents } = dijkstra(source, adjacency, edges);
    for (const [target, value] of distances) {
      if (value > bestDistance && Number.isFinite(value)) {
        bestDistance = value;
        bestSource = source;
        bestTarget = target;
        bestParents = parents;
      }
    }
  }

  const pathSteps: Array<{ fromNodeId: string; toNodeId: string; edgeIndex: number }> = [];
  let current = bestTarget;
  while (current !== bestSource) {
    const parent = bestParents.get(current);
    if (!parent) {
      throw new Error(`Unable to reconstruct principal SUMO path for '${name}'.`);
    }
    pathSteps.push({
      fromNodeId: parent.previousNodeId,
      toNodeId: current,
      edgeIndex: parent.edgeIndex,
    });
    current = parent.previousNodeId;
  }
  pathSteps.reverse();

  const points: SitecheckOverlayPoint[] = [];
  const sourceEdgeIds: string[] = [];

  for (const step of pathSteps) {
    const edge = edges[step.edgeIndex];
    sourceEdgeIds.push(edge.edgeId);
    const edgePoints = edge.fromNodeId === step.fromNodeId && edge.toNodeId === step.toNodeId
      ? edge.points
      : [...edge.points].reverse();

    for (const point of edgePoints) {
      const previous = points[points.length - 1];
      if (!previous || distance(previous, point) >= 0.02) {
        points.push(point);
      }
    }
  }

  if (points.length < 2) {
    throw new Error(`Principal SUMO path for '${name}' has fewer than two points.`);
  }

  const sourceWayIds = [...new Set(
    pathSteps.map((step) => edges[step.edgeIndex].osmWayId),
  )].sort(compareNumericStrings);

  return {
    name,
    points,
    lengthMetres: polylineLength(points),
    minimumDistanceToCentreMetres: minimumDistanceToPolyline(
      { x: localCentre, y: localCentre },
      points,
    ),
    sourceWayIds,
    sourceEdgeIds,
    highway: chooseHighestRoadClass(
      pathSteps.map((step) => edges[step.edgeIndex].highway),
    ),
    widthMetres: Math.max(
      ...pathSteps.map((step) => edges[step.edgeIndex].widthMetres),
    ),
  };
}

export function comparePrincipalComponents(
  a: PrincipalComponent,
  b: PrincipalComponent,
): number {
  const distanceDifference =
    a.minimumDistanceToCentreMetres - b.minimumDistanceToCentreMetres;
  if (Math.abs(distanceDifference) > 0.01) return distanceDifference;
  return b.lengthMetres - a.lengthMetres;
}

export function canonicalPointKey(
  points: readonly SitecheckOverlayPoint[],
): string {
  const forward = points.map(roundPointKey).join('|');
  const reverse = [...points].reverse().map(roundPointKey).join('|');
  return forward < reverse ? forward : reverse;
}

export function compareNumericStrings(a: string, b: string): number {
  const numericA = Number(a);
  const numericB = Number(b);
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) {
    return numericA - numericB;
  }
  return a.localeCompare(b);
}

function reverseEdge(edge: RawSumoEdge): RawSumoEdge {
  return {
    ...edge,
    edgeId: edge.edgeId.startsWith('-') ? edge.edgeId.slice(1) : edge.edgeId,
    fromNodeId: edge.toNodeId,
    toNodeId: edge.fromNodeId,
    points: [...edge.points].reverse(),
  };
}

function dijkstra(
  source: string,
  adjacency: ReadonlyMap<string, Array<{ edgeIndex: number; otherNodeId: string }>>,
  edges: readonly RawSumoEdge[],
): {
  distances: Map<string, number>;
  parents: Map<string, { previousNodeId: string; edgeIndex: number }>;
} {
  const distances = new Map<string, number>();
  const parents = new Map<string, { previousNodeId: string; edgeIndex: number }>();
  const unvisited = new Set(adjacency.keys());

  for (const node of unvisited) distances.set(node, Number.POSITIVE_INFINITY);
  distances.set(source, 0);

  while (unvisited.size > 0) {
    let currentNode: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;

    for (const node of unvisited) {
      const candidate = distances.get(node) ?? Number.POSITIVE_INFINITY;
      if (candidate < currentDistance) {
        currentDistance = candidate;
        currentNode = node;
      }
    }

    if (!currentNode || !Number.isFinite(currentDistance)) break;
    unvisited.delete(currentNode);

    for (const link of adjacency.get(currentNode) ?? []) {
      if (!unvisited.has(link.otherNodeId)) continue;
      const candidate = currentDistance + edges[link.edgeIndex].lengthMetres;
      if (candidate < (distances.get(link.otherNodeId) ?? Number.POSITIVE_INFINITY)) {
        distances.set(link.otherNodeId, candidate);
        parents.set(link.otherNodeId, {
          previousNodeId: currentNode,
          edgeIndex: link.edgeIndex,
        });
      }
    }
  }

  return { distances, parents };
}

function chooseHighestRoadClass(highways: readonly string[]): string {
  const priority = [
    'motorway',
    'motorway_link',
    'trunk',
    'trunk_link',
    'primary',
    'primary_link',
    'secondary',
    'secondary_link',
    'tertiary',
    'tertiary_link',
    'unclassified',
    'residential',
    'living_street',
  ];
  return [...highways].sort(
    (a, b) => priority.indexOf(a) - priority.indexOf(b),
  )[0] ?? 'road';
}

function polylineLength(points: readonly SitecheckOverlayPoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

function minimumDistanceToPolyline(
  target: SitecheckOverlayPoint,
  points: readonly SitecheckOverlayPoint[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    minimum = Math.min(
      minimum,
      distanceToSegment(target, points[index - 1], points[index]),
    );
  }
  return minimum;
}

function distanceToSegment(
  point: SitecheckOverlayPoint,
  start: SitecheckOverlayPoint,
  end: SitecheckOverlayPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return distance(point, start);

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + t * dx),
    point.y - (start.y + t * dy),
  );
}

function distance(a: SitecheckOverlayPoint, b: SitecheckOverlayPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function roundPointKey(point: SitecheckOverlayPoint): string {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

function appendMapArray<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
