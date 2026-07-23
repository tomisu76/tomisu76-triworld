import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: ['./src/beamng-v4/test-fixture-setup.ts'],
      testTimeout: 20_000,
    },
  }),
);
