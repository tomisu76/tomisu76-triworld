export function syntheticAbsoluteElevation(x: number, y: number): number {
  return 500.0 + 0.002 * x + 0.004 * y + 0.00002 * x * x - 0.00001 * y * y;
}
