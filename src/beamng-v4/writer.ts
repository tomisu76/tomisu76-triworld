import type { BeamNGTerrainArtifact } from './types';

export function writeBeamNGTer(artifact: BeamNGTerrainArtifact): Uint8Array {
  const { version, size, heightMapU16, layerMapU8, materialNames } = artifact;

  if (size < 16 || (size & (size - 1)) !== 0) {
    throw new Error(`Invalid terrain size: ${size}`);
  }

  const sampleCount = size * size;
  if (heightMapU16.length !== sampleCount) {
    throw new Error(`Height map length mismatch: expected ${sampleCount}, got ${heightMapU16.length}`);
  }
  if (layerMapU8.length !== sampleCount) {
    throw new Error(`Layer map length mismatch: expected ${sampleCount}, got ${layerMapU8.length}`);
  }

  // Validate layer indices
  for (let i = 0; i < sampleCount; i++) {
    const idx = layerMapU8[i];
    if (idx !== 255 && idx >= materialNames.length) {
      throw new Error(`Layer map sample ${i} has index ${idx} exceeding materialNames length ${materialNames.length}`);
    }
  }

  const textEncoder = new TextEncoder();
  const encodedMaterialNames = materialNames.map((name) => {
    const encoded = textEncoder.encode(name);
    if (encoded.length > 255) {
      throw new Error(`Material name exceeds 255 bytes: "${name}"`);
    }
    return encoded;
  });

  let materialsByteSize = 4; // uint32 LE materialCount
  for (const nameBytes of encodedMaterialNames) {
    materialsByteSize += 1 + nameBytes.length; // 1 byte length + UTF-8 bytes
  }

  const totalByteLength = 1 + 4 + sampleCount * 2 + sampleCount * 1 + materialsByteSize;
  const buffer = new Uint8Array(totalByteLength);
  const view = new DataView(buffer.buffer);

  // 1. Version (u8)
  buffer[0] = version;

  // 2. Size (u32 LE)
  view.setUint32(1, size, true);

  // 3. Height Map (u16 LE)
  let offset = 5;
  for (let i = 0; i < sampleCount; i++) {
    view.setUint16(offset, heightMapU16[i], true);
    offset += 2;
  }

  // 4. Layer Map (u8)
  buffer.set(layerMapU8, offset);
  offset += sampleCount;

  // 5. Material Count (u32 LE)
  view.setUint32(offset, materialNames.length, true);
  offset += 4;

  // 6. Material Names
  for (const nameBytes of encodedMaterialNames) {
    buffer[offset] = nameBytes.length;
    offset += 1;
    buffer.set(nameBytes, offset);
    offset += nameBytes.length;
  }

  if (offset !== totalByteLength) {
    throw new Error(`Writer internal offset mismatch: written ${offset}, total ${totalByteLength}`);
  }

  return buffer;
}
