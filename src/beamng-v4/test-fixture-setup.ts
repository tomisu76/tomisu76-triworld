import fs from 'node:fs';
import path from 'node:path';
import { writeBeamNGTer } from './writer';
import type { BeamNGTerrainArtifact } from './types';

/**
 * The real smallgrid fixture is intentionally local and is not committed to
 * the repository. CI creates a minimal format-compatible substitute only when
 * that external reference is absent. Local validation keeps using the real
 * BeamNG fixture and this file never overwrites it.
 */
const fixturePath = path.join(process.cwd(), 'test-fixtures', 'beamng-native-reference', 'terrain.ter');

if (!fs.existsSync(fixturePath)) {
  const size = 256;
  const sampleCount = size * size;
  const fixture = {
    version: 9,
    size,
    squareSize: 1,
    maxHeight: 100,
    heightScale: 100 / 65535,
    heightMapU16: new Uint16Array(sampleCount),
    layerMapU8: new Uint8Array(sampleCount),
    materialNames: ['test'],
    minimumDecodedElevation: 0,
    maximumDecodedElevation: 0,
  } as unknown as BeamNGTerrainArtifact;

  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, writeBeamNGTer(fixture));
}
