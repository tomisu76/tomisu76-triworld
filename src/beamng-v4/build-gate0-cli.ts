import { buildGate0ZipPackage } from './zip-builder';

async function main() {
  console.log('Building TriWorld V4 Gate 0 BeamNG package...');
  const { zipPath, manifestPath, manifest } = await buildGate0ZipPackage('dist');
  console.log('SUCCESS!');
  console.log('Zip package:', zipPath);
  console.log('Manifest path:', manifestPath);
  console.log('Manifest contents:\n', JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
