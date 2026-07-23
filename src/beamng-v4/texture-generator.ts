import zlib from 'node:zlib';

function createCrcTable(): Uint32Array {
  const cTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    cTable[n] = c;
  }
  return cTable;
}

const crcTable = createCrcTable();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);

  const crcTarget = chunk.subarray(4, 8 + data.length);
  const crcVal = crc32(crcTarget);
  view.setUint32(8 + data.length, crcVal, false);

  return chunk;
}

export function generateCustomPng(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number]
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // 8 bit depth
  ihdr[9] = 2; // Color type 2 (RGB)
  ihdr[10] = 0; // Compression 0
  ihdr[11] = 0; // Filter 0
  ihdr[12] = 0; // Interlace 0

  const ihdrChunk = makePngChunk('IHDR', ihdr);

  // IDAT chunk
  const rowStride = 1 + width * 3;
  const rawImage = new Uint8Array(height * rowStride);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    rawImage[rowOffset] = 0; // Filter type None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const pixelOffset = rowOffset + 1 + x * 3;
      rawImage[pixelOffset + 0] = Math.max(0, Math.min(255, Math.round(r)));
      rawImage[pixelOffset + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rawImage[pixelOffset + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  const compressed = zlib.deflateSync(rawImage);
  const idatChunk = makePngChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const totalLength = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(totalLength);
  let offset = 0;

  png.set(signature, offset); offset += signature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset); offset += iendChunk.length;

  return png;
}

export function generateSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  return generateCustomPng(width, height, () => [r, g, b]);
}
