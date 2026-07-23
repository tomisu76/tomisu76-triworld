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
  const layerMapByteLength = sampleCount;
  const minRequiredLength = 1 + 4 + heightMapByteLength + layerMapByteLength + 4;

  if (bytes.byteLength < minRequiredLength) {
    throw new Error(`Truncated .ter file: expected at least ${minRequiredLength} bytes, got ${bytes.byteLength}`);
  }

  const heightMapOffset = 5;
  const heightMapU16 = new Uint16Array(sampleCount);
  let minimumDecodedElevation = Number.POSITIVE_INFINITY;
  let maximumDecodedElevation = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < sampleCount; i++) {
    const value = view.getUint16(heightMapOffset + i * 2, true);
    heightMapU16[i] = value;
    minimumDecodedElevation = Math.min(minimumDecodedElevation, value);
    maximumDecodedElevation = Math.max(maximumDecodedElevation, value);
  }

  const layerMapOffset = heightMapOffset + heightMapByteLength;
  const layerMapU8 = new Uint8Array(bytes.subarray(layerMapOffset, layerMapOffset + layerMapByteLength));

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

  for (let i = 0; i < sampleCount; i++) {
    const layerIndex = layerMapU8[i];
    if (layerIndex !== 255 && layerIndex >= materialNames.length) {
      throw new Error(`Layer map sample ${i} contains invalid material index ${layerIndex} (material count: ${materialNames.length})`);
    }
  }

  // The binary TER payload does not contain world scale metadata. The reader
  // therefore exposes raw-height units (1 unit per encoded step). Callers that
  // also load the companion .terrain.json can replace these neutral defaults.
  return {
    version,
    size,
    squareSize: 1,
    maxHeight: 65535,
    heightScale: 1,
    minimumDecodedElevation,
    maximumDecodedElevation,
    heightMapU16,
    layerMapU8,
    materialNames,
  };
}
