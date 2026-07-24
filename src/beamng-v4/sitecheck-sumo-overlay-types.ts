export interface SitecheckOverlayPoint {
  x: number;
  y: number;
}

export interface SitecheckRoadOverlay {
  wayId: string;
  sourceWayIds: string[];
  sourceEdgeIds: string[];
  name: string;
  highway: string;
  widthMetres: number;
  localPoints: SitecheckOverlayPoint[];
  lengthMetres: number;
  minimumDistanceToCentreMetres: number;
}

export interface SitecheckRoadAudit {
  name: string;
  sourceWayIds: string[];
  rawDirectedEdgeCount: number;
  canonicalEdgeCount: number;
  connectedComponentCount: number;
  selectedComponentCount: number;
  selectedOverlayCount: number;
  selectedLengthMetres: number;
  minimumDistanceToCentreMetres: number;
}

export interface SitecheckOverlayResolution {
  sourceType: 'sumo-netconvert-principal-centerlines';
  netOffset: { x: number; y: number };
  projection: string;
  roads: SitecheckRoadOverlay[];
  audits: SitecheckRoadAudit[];
}

export interface OsmWayMetadata {
  wayId: string;
  name: string;
  highway: string;
  widthMetres: number;
}

export interface RawSumoEdge {
  edgeId: string;
  segmentKey: string;
  osmWayId: string;
  name: string;
  highway: string;
  widthMetres: number;
  fromNodeId: string;
  toNodeId: string;
  points: SitecheckOverlayPoint[];
  lengthMetres: number;
}

export interface PrincipalComponent {
  name: string;
  points: SitecheckOverlayPoint[];
  lengthMetres: number;
  minimumDistanceToCentreMetres: number;
  sourceWayIds: string[];
  sourceEdgeIds: string[];
  highway: string;
  widthMetres: number;
}

export interface SitecheckResolverOptions {
  localSampleOffsetMetres?: number;
  clippingMinimum?: number;
  clippingMaximum?: number;
  maximumPrincipalComponentsPerRoad?: number;
  parallelComponentToleranceMetres?: number;
  minimumOverlayLengthMetres?: number;
}

export const DRIVEABLE_HIGHWAY_TYPES = new Set([
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
  'residential',
  'unclassified',
  'living_street',
]);
