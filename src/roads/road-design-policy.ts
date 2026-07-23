export interface RoadDesignPolicy {
  highwayClass: string;
  preferredMaximumGrade: number;
  absoluteMaximumGrade: number;
  stationSpacing: number;
  shoulderWidth: number;
  crossfall: number;
  cutSlopeHorizontalPerVertical: number;
  fillSlopeHorizontalPerVertical: number;
  minimumVerticalCurveLength: number;
}

export function getRoadDesignPolicy(highwayClass: string): RoadDesignPolicy {
  switch (highwayClass) {
    case 'motorway':
    case 'motorway_link':
    case 'trunk':
    case 'trunk_link':
      return {
        highwayClass,
        preferredMaximumGrade: 0.05,
        absoluteMaximumGrade: 0.07,
        stationSpacing: 2.5,
        shoulderWidth: 1.5,
        crossfall: 0.02,
        cutSlopeHorizontalPerVertical: 2.0,
        fillSlopeHorizontalPerVertical: 2.0,
        minimumVerticalCurveLength: 30.0,
      };
    case 'primary':
    case 'primary_link':
    case 'secondary':
    case 'secondary_link':
      return {
        highwayClass,
        preferredMaximumGrade: 0.06,
        absoluteMaximumGrade: 0.08,
        stationSpacing: 2.5,
        shoulderWidth: 1.0,
        crossfall: 0.02,
        cutSlopeHorizontalPerVertical: 2.0,
        fillSlopeHorizontalPerVertical: 2.0,
        minimumVerticalCurveLength: 25.0,
      };
    case 'tertiary':
    case 'tertiary_link':
    case 'residential':
    case 'living_street':
    case 'unclassified':
    case 'road':
      return {
        highwayClass,
        preferredMaximumGrade: 0.08,
        absoluteMaximumGrade: 0.10,
        stationSpacing: 2.5,
        shoulderWidth: 1.0,
        crossfall: 0.02,
        cutSlopeHorizontalPerVertical: 2.0,
        fillSlopeHorizontalPerVertical: 2.0,
        minimumVerticalCurveLength: 20.0,
      };
    case 'service':
    case 'track':
    default:
      return {
        highwayClass,
        preferredMaximumGrade: 0.10,
        absoluteMaximumGrade: 0.14,
        stationSpacing: 2.5,
        shoulderWidth: 0.8,
        crossfall: 0.02,
        cutSlopeHorizontalPerVertical: 1.5,
        fillSlopeHorizontalPerVertical: 1.5,
        minimumVerticalCurveLength: 15.0,
      };
  }
}
