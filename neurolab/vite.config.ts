import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Served by the Glassbox MD app at /neurolab/ (see src/glassbox_md/neurolab.py), so every asset URL in the
  // build has to start there. tests/test_neurolab_real_build.py checks this on the Python side.
  base: '/neurolab/',
  build: {
    chunkSizeWarningLimit: 750,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
