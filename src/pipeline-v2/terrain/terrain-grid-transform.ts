export type BeamNgPresetV2 = 512 | 1024 | 2048 | 4096;

export interface TerrainGridTransformV2 {
  resolution: BeamNgPresetV2;
  squareSize: 1;
  worldSizeMetres: number;
  originX: number;
  originY: number;
  rowOrientation: 'south-to-north';
  columnOrientation: 'west-to-east';
}

export function createTerrainGridTransformV2(resolution: BeamNgPresetV2): TerrainGridTransformV2 {
  const half = resolution / 2;
  return {
    resolution,
    squareSize: 1,
    worldSizeMetres: resolution,
    originX: -half,
    originY: -half,
    rowOrientation: 'south-to-north',
    columnOrientation: 'west-to-east',
  };
}

export function gridColumnToLocalX(transform: TerrainGridTransformV2, col: number): number {
  return transform.originX + col * transform.squareSize;
}

export function gridRowToLocalY(transform: TerrainGridTransformV2, row: number): number {
  return transform.originY + row * transform.squareSize;
}

export function localXToGridColumn(transform: TerrainGridTransformV2, xMetres: number): number {
  return Math.round((xMetres - transform.originX) / transform.squareSize);
}

export function localYToGridRow(transform: TerrainGridTransformV2, yMetres: number): number {
  return Math.round((yMetres - transform.originY) / transform.squareSize);
}

export function localXToContinuousColumn(transform: TerrainGridTransformV2, xMetres: number): number {
  return (xMetres - transform.originX) / transform.squareSize;
}

export function localYToContinuousRow(transform: TerrainGridTransformV2, yMetres: number): number {
  return (yMetres - transform.originY) / transform.squareSize;
}
