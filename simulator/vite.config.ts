import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The simulator is served by the Glassbox MD app at /cathlab/ (see src/glassbox_md/cathlab.py),
  // so every asset URL in the build has to start there. A test on the Python side checks this
  // matches CATHLAB_PATH.
  base: '/cathlab/',
  build: {
    // Three.js alone is about 570 kB (145 kB gzipped). It sits in its own chunk that is loaded only when
    // someone leaves the start screen, so the warning's default 500 kB is just noise here.
    chunkSizeWarningLimit: 650,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
