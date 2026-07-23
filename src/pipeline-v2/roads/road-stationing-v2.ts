export interface RoadPointV2 {
  x: number; // metres East
  y: number; // metres North
}

export interface DesignedStationV2 {
  stationMetres: number;
  xMetres: number;
  yMetres: number;
  groundZ: number;
  designZ: number;
}

export function resampleRoadStationingV2(
  points: RoadPointV2[],
  stationSpacingMetres: number = 1.0,
): DesignedStationV2[] {
  if (points.length < 2) return [];

  // Filter duplicate nodes (< 0.05m)
  const clean: RoadPointV2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = clean[clean.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= 0.05) {
      clean.push(p);
    }
  }

  if (clean.length < 2) return [];

  // Compute cumulative 2D distance
  const cumDist: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    const d = Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y);
    cumDist.push(cumDist[i - 1] + d);
  }

  const totalLength = cumDist[cumDist.length - 1];
  if (totalLength < 0.1) return [];

  const numSteps = Math.max(1, Math.ceil(totalLength / stationSpacingMetres));
  const step = totalLength / numSteps;

  const result: DesignedStationV2[] = [];

  let segmentIdx = 0;
  for (let i = 0; i <= numSteps; i++) {
    const targetS = Math.min(totalLength, i * step);

    while (segmentIdx < clean.length - 2 && cumDist[segmentIdx + 1] < targetS) {
      segmentIdx++;
    }

    const s0 = cumDist[segmentIdx];
    const s1 = cumDist[segmentIdx + 1];
    const p0 = clean[segmentIdx];
    const p1 = clean[segmentIdx + 1];

    const t = (s1 - s0) < 1e-6 ? 0 : (targetS - s0) / (s1 - s0);
    const xMetres = p0.x + t * (p1.x - p0.x);
    const yMetres = p0.y + t * (p1.y - p0.y);

    result.push({
      stationMetres: targetS,
      xMetres,
      yMetres,
      groundZ: 0,
      designZ: 0,
    });
  }

  return result;
}
