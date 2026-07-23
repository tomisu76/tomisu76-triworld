export interface TerrainGridConfigV3 {
  N: number; // e.g. 512
  squareSize: number; // e.g. 1.0
}

export class TerrainGridV3 {
  public readonly N: number;
  public readonly squareSize: number;
  public readonly anchorElevation: number;
  private readonly sourceElevations: Float32Array;
  public readonly workingElevations: Float32Array;

  constructor(
    N: number,
    squareSize: number,
    absoluteElevationFactory: (x: number, y: number) => number,
  ) {
    if (N < 2 || N % 2 !== 0 || !Number.isInteger(N)) {
      throw new Error(`Terrain grid resolution N must be an even integer >= 2, got ${N}`);
    }
    if (!Number.isFinite(squareSize) || squareSize <= 0) {
      throw new Error(`squareSize must be a finite number > 0, got ${squareSize}`);
    }

    this.N = N;
    this.squareSize = squareSize;

    // Calculate anchor elevation at mathematical center (x = 0, y = 0)
    this.anchorElevation = absoluteElevationFactory(0, 0);

    const count = N * N;
    this.sourceElevations = new Float32Array(count);
    this.workingElevations = new Float32Array(count);

    const half = (N - 1) / 2;

    for (let row = 0; row < N; row++) {
      const y = (half - row) * squareSize;
      for (let col = 0; col < N; col++) {
        const x = (col - half) * squareSize;
        const absZ = absoluteElevationFactory(x, y);
        const relZ = absZ - this.anchorElevation;
        const idx = row * N + col;
        this.sourceElevations[idx] = relZ;
        this.workingElevations[idx] = relZ;
      }
    }
  }

  public columnToX(col: number): number {
    return (col - (this.N - 1) / 2) * this.squareSize;
  }

  public rowToY(row: number): number {
    return ((this.N - 1) / 2 - row) * this.squareSize;
  }

  public xToContinuousColumn(x: number): number {
    return x / this.squareSize + (this.N - 1) / 2;
  }

  public yToContinuousRow(y: number): number {
    return (this.N - 1) / 2 - y / this.squareSize;
  }

  public getSourceElevation(index: number): number {
    if (index < 0 || index >= this.sourceElevations.length) {
      throw new RangeError(`Source elevation index out of bounds: ${index}`);
    }
    return this.sourceElevations[index];
  }

  public getSourceElevationArray(): Float32Array {
    return new Float32Array(this.sourceElevations);
  }

  public sampleSourceStrict(x: number, y: number): number {
    const colCont = this.xToContinuousColumn(x);
    const rowCont = this.yToContinuousRow(y);

    if (colCont < 0 || colCont > this.N - 1 || rowCont < 0 || rowCont > this.N - 1) {
      throw new RangeError(`Engineering sample coordinates (${x}, ${y}) out of domain bounds [${this.columnToX(0)}, ${this.columnToX(this.N - 1)}]`);
    }

    const c0 = Math.floor(colCont);
    const r0 = Math.floor(rowCont);
    const c1 = Math.min(this.N - 1, c0 + 1);
    const r1 = Math.min(this.N - 1, r0 + 1);

    const tx = colCont - c0;
    const ty = rowCont - r0;

    const z00 = this.sourceElevations[r0 * this.N + c0];
    const z10 = this.sourceElevations[r0 * this.N + c1];
    const z01 = this.sourceElevations[r1 * this.N + c0];
    const z11 = this.sourceElevations[r1 * this.N + c1];

    const zBottom = z00 + (z10 - z00) * tx;
    const zTop = z01 + (z11 - z01) * tx;
    return zBottom + (zTop - zBottom) * ty;
  }

  public sampleWorkingStrict(x: number, y: number): number {
    const colCont = this.xToContinuousColumn(x);
    const rowCont = this.yToContinuousRow(y);

    if (colCont < 0 || colCont > this.N - 1 || rowCont < 0 || rowCont > this.N - 1) {
      throw new RangeError(`Engineering sample coordinates (${x}, ${y}) out of domain bounds [${this.columnToX(0)}, ${this.columnToX(this.N - 1)}]`);
    }

    const c0 = Math.floor(colCont);
    const r0 = Math.floor(rowCont);
    const c1 = Math.min(this.N - 1, c0 + 1);
    const r1 = Math.min(this.N - 1, r0 + 1);

    const tx = colCont - c0;
    const ty = rowCont - r0;

    const z00 = this.workingElevations[r0 * this.N + c0];
    const z10 = this.workingElevations[r0 * this.N + c1];
    const z01 = this.workingElevations[r1 * this.N + c0];
    const z11 = this.workingElevations[r1 * this.N + c1];

    const zBottom = z00 + (z10 - z00) * tx;
    const zTop = z01 + (z11 - z01) * tx;
    return zBottom + (zTop - zBottom) * ty;
  }
}
