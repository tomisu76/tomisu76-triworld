import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-test03-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-test04-wrapper.ts');

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');
  transformed = transformed.split("'test03'").join("'test04'");
  transformed = transformed.split('TEST03').join('TEST04');
  transformed = transformed.replace(
    "const GENERATED = path.resolve('src/beamng-v4/.generated-build-test03-cli.ts');",
    "const GENERATED = path.resolve('src/beamng-v4/.generated-build-test04-cli.ts');",
  );

  // After TEST03 creates its final generated production builder, remove the
  // road DAE from the packaged level. This isolates native TerrainBlock
  // rendering/collision from malformed TSStatic road collision geometry.
  transformed = transformed.replace(
    "  fs.writeFileSync(GENERATED, transformed, 'utf-8');",
    "  transformed = transformed.replace('    roadDae,\\n', '    roadDae: undefined,\\n');\n  fs.writeFileSync(GENERATED, transformed, 'utf-8');",
  );
  transformed = transformed.replace(
    '`test03 build exited with code ${result.status}.`',
    '`test04 build exited with code ${result.status}.`',
  );
  transformed = transformed.replace(
    'FATAL TEST03 BUILD ERROR:',
    'FATAL TEST04 BUILD ERROR:',
  );

  fs.writeFileSync(GENERATED, transformed, 'utf-8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(), stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`test04 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try { main(); } catch (error) {
  console.error('FATAL TEST04 BUILD ERROR:', error);
  process.exit(1);
}
