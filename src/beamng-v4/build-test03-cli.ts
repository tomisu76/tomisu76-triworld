import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-test02-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-test03-cli.ts');

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');
  transformed = transformed.split("'test02'").join("'test03'");
  transformed = transformed.split('TEST02').join('TEST03');
  transformed = transformed.replace(
    'stations[Math.min(20, stations.length - 1)]',
    'stations[Math.min(100, stations.length - 1)]',
  );
  transformed = transformed.replace(
    'sampleTerrainElevation(spawnLogicalX, spawnLogicalY) + 1.5',
    'sampleTerrainElevation(spawnLogicalX, spawnLogicalY) + 5.0',
  );
  transformed = transformed.replace(
    '`test02 build exited with code ${result.status}.`',
    '`test03 build exited with code ${result.status}.`',
  );
  transformed = transformed.replace(
    'FATAL TEST02 BUILD ERROR:',
    'FATAL TEST03 BUILD ERROR:',
  );

  fs.writeFileSync(GENERATED, transformed, 'utf-8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(), stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`test03 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try { main(); } catch (error) {
  console.error('FATAL TEST03 BUILD ERROR:', error);
  process.exit(1);
}
