import type { SumoLaneGeometry } from '../sumo/SumoGeometryV3';

export const syntheticLane: SumoLaneGeometry = {
  edgeId: 'synthetic-edge',
  laneId: 'synthetic-edge_0',
  laneIndex: 0,
  width: 3.5,
  speed: 13.89,
  function: 'normal',
  shape: [
    { x: -190, y: -60 },
    { x: -120, y: -30 },
    { x: -45, y: 15 },
    { x: 40, y: 38 },
    { x: 125, y: 20 },
    { x: 190, y: -25 },
  ],
};
