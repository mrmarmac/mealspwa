import { defineConfig } from 'vitest/config';

// The worker's pure logic (src/store.ts) is unit-tested under plain Node —
// no D1, no wrangler. The request handler in src/index.ts is exercised
// end-to-end by the client-side round-trip test in the root package, which
// mirrors this worker's push/pull/LWW/auth contract against a fake server.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
});
