import { defineConfig } from 'vitest/config';

// .mts so vitest loads this config via native ESM. The .ts/CJS loader path
// require()s `std-env`, which is ESM-only on recent versions and throws
// ERR_REQUIRE_ESM under Node >= 22.
export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
