import { spawnSync } from 'node:child_process';

function runCommand(command: string, args: string[]) {
  console.log(`\n=== Running: ${command} ${args.join(' ')} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\n❌ Command failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}

function main() {
  console.log('🚀 Starting Gate 3 Strict Verification Pipeline...');

  // 1. Build project
  runCommand('npm', ['run', 'build']);

  // 2. Run automated tests (Vitest)
  runCommand('npx', ['vitest', 'run']);

  // 3. Execute authoritative Gate 3 Builder and Validator
  runCommand('npx', ['tsx', 'src/beamng-v4/build-gate3-cli.ts']);

  console.log('\n✅ Gate 3 Strict Verification Pipeline Completed Successfully!');
}

main();
