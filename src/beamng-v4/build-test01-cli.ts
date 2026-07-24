import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-framefixed1-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-test01-cli.ts');

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');
  const oldLevel = 'triworld_v4_gate4_framefixed1';
  const newLevel = 'test01';
  if (!transformed.includes(oldLevel)) {
    throw new Error(`Expected level name ${oldLevel} not found in source builder.`);
  }
  transformed = transformed.split(oldLevel).join(newLevel);
  fs.writeFileSync(GENERATED, transformed, 'utf-8');

  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`test01 build exited with code ${result.status}.`);
    }
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL TEST01 BUILD ERROR:', error);
  process.exit(1);
}
