export interface BeamNGTerrainArtifact {
  version: number;
  size: number;
  heightMapU16: Uint16Array;
  layerMapU8: Uint8Array;
  materialNames: readonly string[];
}

export interface BeamNGTargetInfo {
  beamngVersion: string;
  buildNumber: string;
  terrainFileVersion: number;
  dateValidated: string;
  userfolder: string;
}

export interface AnalyticTerrainResult {
  size: number;
  squareSize: number;
  maxHeight: number;
  heightScale: number;
  terrainPosition: [number, number, number];
  heightsFloat32: Float32Array;
  heightMapU16: Uint16Array;
  controlPoints: {
    p0_0: { unquantized: number; decoded: number };
    p511_0: { unquantized: number; decoded: number };
    p0_511: { unquantized: number; decoded: number };
    p511_511: { unquantized: number; decoded: number };
    p256_256: { unquantized: number; decoded: number };
  };
  minElevation: number;
  maxElevation: number;
}

export interface ValidationManifest {
  targetBeamNgBuild: string;
  terrainVersion: number;
  terrainSize: number;
  squareSize: number;
  maxHeight: number;
  heightScale: number;
  terrainPosition: [number, number, number];
  minimumDecodedElevation: number;
  maximumDecodedElevation: number;
  controlPointElevations: {
    p0_0: number;
    p511_0: number;
    p0_511: number;
    p511_511: number;
    p256_256: number;
  };
  heightMapHash: string;
  layerMapHash: string;
  terHash: string;
  packagedFileHashes: Record<string, string>;
  zipManifestHash: string;
}
