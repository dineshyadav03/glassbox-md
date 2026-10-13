import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The simulator is served by the Glassbox MD app at /cathlab/ (see src/glassbox_md/cathlab.py),
  // so every asset URL in the build has to start there. A test on the Python side checks this
  // matches CATHLAB_PATH.
  base: '/cathlab/',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
