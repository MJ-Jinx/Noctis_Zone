import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // compiled/ (see scripts/run-compile.mjs) is generated JS, not
      // hand-written source — but it's deliberately INCLUDED, not
      // excluded: its coverage is the most meaningful signal this suite
      // can produce, showing whether every circuit and branch in the real
      // deployed contract logic actually got exercised by some test, not
      // just whether the compiler's own codegen ran. compiled_realzk/
      // (full ZK proving-key build, not used by these tests at all — see
      // README) is excluded since nothing here ever imports it.
      include: ['compiled/**/*.js', 'witnesses.ts'],
      exclude: ['compiled_realzk/**', '**/*.d.ts'],
    },
  },
});
