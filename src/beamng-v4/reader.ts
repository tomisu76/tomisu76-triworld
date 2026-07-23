import type { BeamNGTerrainArtifact } from './types';

export function readBeamNGTer(input: ArrayBuffer | Uint8Array): BeamNGTerrainArtifact {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 5) {
    throw new Error(`Invalid .ter file: header too short (${bytes.byteLength} bytes)`);
  }

  const version = bytes[0];
  if (version < 1 || version > 16) {
    throw new Error(`Unsupported .ter version: ${version}`);
  }

  const size = view.getUint32(1, true);
  if (size < 16 || (size & (size - 1)) !== 0) {
    throw new Error(`Invalid .ter terrain size: ${size} (must be power of 2 >= 16)`);
  }

  const sampleCount = size * size;
  const heightMapByteLength = sampleCount * 2;
  const layerMapByteLength = sampleCount * 1;
  const minRequiredLength = 1 + 4 + heightMapByteLength + layerMapByteLength + 4;

  if (bytes.byteLength < minRequiredLength) {
    throw new Error(`Truncated .ter file: expected at least ${minRequiredLength} bytes, got ${bytes.byteLength}`);
  }

  // Read heightMapU16
  const heightMapOffset = 5;
  const heightMapU16 = new Uint16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    heightMapU16[i] = view.getUint16(heightMapOffset + i * 2, true);
  }

  // Read layerMapU8
  const layerMapOffset = heightMapOffset + heightMapByteLength;
  const layerMapU8 = new Uint8Array(bytes.subarray(layerMapOffset, layerMapOffset + layerMapByteLength));

  // Read Material Section
  let cursor = layerMapOffset + layerMapByteLength;
  if (cursor + 4 > bytes.byteLength) {
    throw new Error(`Truncated .ter material count header at offset ${cursor}`);
  }

  const materialCount = view.getUint32(cursor, true);
  cursor += 4;

  const materialNames: string[] = [];
  const textDecoder = new TextDecoder('utf-8');

  for (let i = 0; i < materialCount; i++) {
    if (cursor + 1 > bytes.byteLength) {
      throw new Error(`Truncated .ter material string length for index ${i} at offset ${cursor}`);
    }
    const strLen = bytes[cursor];
    cursor += 1;

    if (cursor + strLen > bytes.byteLength) {
      throw new Error(`Truncated .ter material string content for index ${i} (expected ${strLen} bytes) at offset ${cursor}`);
    }

    const strBytes = bytes.subarray(cursor, cursor + strLen);
    cursor += strLen;
    materialNames.push(textDecoder.decode(strBytes));
  }

  if (cursor !== bytes.byteLength) {
    throw new Error(`Trailing unexplained bytes in .ter file: expected EOF at ${cursor}, file length is ${bytes.byteLength}`);
  }

  // Semantic Layer Index Validation
  for (let i = 0; i < sampleCount; i++) {
    const layerIndex = layerMapU8[i];
    if (layerIndex !== 255 && layerIndex >= materialNames.length) {
      throw new Error(`Layer map sample ${i} contains invalid material index ${layerIndex} (material count: ${materialNames.length})`);
    }
  }

  return {
    version,
    size,
    heightMapU16,
    layerMapU8,
    materialNames,
  };
}
