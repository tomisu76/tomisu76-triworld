import fs from 'node:fs';
import path from 'node:path';

function inspectTer(filePath) {
  const buf = fs.readFileSync(filePath);
  const version = buf[0];
  const size = buf.readUInt32LE(1);
  const heightMapBytes = size * size * 2;
  const layerMapBytes = size * size * 1;
  const materialOffset = 1 + 4 + heightMapBytes + layerMapBytes;
  
  if (materialOffset > buf.length - 4) {
    console.log(`[INVALID] ${filePath}: buf.length=${buf.length}, required min offset=${materialOffset}`);
    return;
  }

  const materialCount = buf.readUInt32LE(materialOffset);
  let cursor = materialOffset + 4;
  const materials = [];

  for (let i = 0; i < materialCount; i++) {
    if (cursor >= buf.length) break;
    const len = buf[cursor];
    cursor += 1;
    const str = buf.toString('utf8', cursor, cursor + len);
    cursor += len;
    materials.push(str);
  }

  console.log(`[OK] ${path.basename(filePath)}: version=${version}, size=${size}x${size}, heightMapBytes=${heightMapBytes}, layerMapBytes=${layerMapBytes}, materialCount=${materialCount}, materials=${JSON.stringify(materials)}, totalRead=${cursor}/${buf.length}`);
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir, { recursive: true });
  for (const f of files) {
    if (f.endsWith('.ter')) {
      inspectTer(path.join(dir, f));
    }
  }
}

scanDir('test-fixtures');
