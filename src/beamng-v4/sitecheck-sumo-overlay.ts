import type { GeodeticTransformer } from './geodetic-transformer';
import {
  buildPrincipalComponent,
  canonicalizeDirectionalEdges,
  canonicalPointKey,
  compareNumericStrings,
  comparePrincipalComponents,
  connectedComponents,
} from './sitecheck-sumo-overlay-graph';
import {
  parseNamedOsmWays,
  parseNamedSumoEdges,
} from './sitecheck-sumo-overlay-xml';
import type {
  SitecheckOverlayResolution,
  SitecheckResolverOptions,
  SitecheckRoadAudit,
  SitecheckRoadOverlay,
} from './sitecheck-sumo-overlay-types';

export type {
  SitecheckOverlayPoint,
  SitecheckOverlayResolution,
  SitecheckResolverOptions,
  SitecheckRoadAudit,
  SitecheckRoadOverlay,
} from './sitecheck-sumo-overlay-types';

export function resolveSitecheckNamedRoadOverlays(
  osmXml: string,
  netXml: string,
  transformer: GeodeticTransformer,
  expectedRoadNames: readonly string[],
  options: SitecheckResolverOptions = {},
): SitecheckOverlayResolution {
  const localSampleOffsetMetres = options.localSampleOffsetMetres ?? 0.5;
  const clippingMinimum = options.clippingMinimum ?? 0;
  const clippingMaximum = options.clippingMaximum ?? transformer.origin.sizeMetres - 1;
  const maximumPrincipalComponentsPerRoad = options.maximumPrincipalComponentsPerRoad ?? 2;
  const parallelComponentToleranceMetres = options.parallelComponentToleranceMetres ?? 15;
  const minimumOverlayLengthMetres = options.minimumOverlayLengthMetres ?? 2;
  const localCentre = (clippingMinimum + clippingMaximum) / 2;

  if (maximumPrincipalComponentsPerRoad < 1) {
    throw new RangeError('maximumPrincipalComponentsPerRoad must be at least one.');
  }

  const osmWays = parseNamedOsmWays(osmXml, expectedRoadNames);
  const parsedSumo = parseNamedSumoEdges(
    netXml,
    osmWays,
    transformer,
    localSampleOffsetMetres,
    clippingMinimum,
    clippingMaximum,
  );

  const roads: SitecheckRoadOverlay[] = [];
  const audits: SitecheckRoadAudit[] = [];

  for (const expectedName of expectedRoadNames) {
    const matchingDirected = parsedSumo.edges.filter(
      (edge) => normalizeName(edge.name) === normalizeName(expectedName),
    );
    if (matchingDirected.length === 0) {
      throw new Error(`No driveable SUMO geometry was resolved for '${expectedName}'.`);
    }

    const canonicalEdges = canonicalizeDirectionalEdges(matchingDirected);
    const components = connectedComponents(canonicalEdges)
      .map((edges) => buildPrincipalComponent(expectedName, edges, localCentre))
      .filter((component) => component.lengthMetres >= minimumOverlayLengthMetres)
      .sort(comparePrincipalComponents);

    const best = components[0];
    if (!best) {
      throw new Error(`No principal SUMO component survived for '${expectedName}'.`);
    }

    const selected = components
      .filter((component, index) => (
        index === 0 ||
        (
          component.minimumDistanceToCentreMetres <=
            best.minimumDistanceToCentreMetres + parallelComponentToleranceMetres &&
          component.lengthMetres >= best.lengthMetres * 0.25
        )
      ))
      .slice(0, maximumPrincipalComponentsPerRoad);

    for (const component of selected) {
      roads.push({
        wayId: component.sourceWayIds.join('+'),
        sourceWayIds: component.sourceWayIds,
        sourceEdgeIds: component.sourceEdgeIds,
        name: component.name,
        highway: component.highway,
        widthMetres: component.widthMetres,
        localPoints: component.points,
        lengthMetres: component.lengthMetres,
        minimumDistanceToCentreMetres: component.minimumDistanceToCentreMetres,
      });
    }

    audits.push({
      name: expectedName,
      sourceWayIds: [...new Set(canonicalEdges.map((edge) => edge.osmWayId))]
        .sort(compareNumericStrings),
      rawDirectedEdgeCount: matchingDirected.length,
      canonicalEdgeCount: canonicalEdges.length,
      connectedComponentCount: components.length,
      selectedComponentCount: selected.length,
      selectedOverlayCount: selected.length,
      selectedLengthMetres: selected.reduce(
        (sum, component) => sum + component.lengthMetres,
        0,
      ),
      minimumDistanceToCentreMetres: Math.min(
        ...selected.map((component) => component.minimumDistanceToCentreMetres),
      ),
    });
  }

  const canonicalGeometry = new Set<string>();
  for (const road of roads) {
    const key = canonicalPointKey(road.localPoints);
    if (canonicalGeometry.has(key)) {
      throw new Error(`Duplicate reverse geometry survived for '${road.name}'.`);
    }
    canonicalGeometry.add(key);
  }

  return {
    sourceType: 'sumo-netconvert-principal-centerlines',
    netOffset: {
      x: parsedSumo.netOffsetX,
      y: parsedSumo.netOffsetY,
    },
    projection: parsedSumo.projection,
    roads,
    audits,
  };
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
