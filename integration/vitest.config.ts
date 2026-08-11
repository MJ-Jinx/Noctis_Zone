import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['**/*.ts'],
      exclude: [
        'tests/**',
        'cli/dist/**',
        '**/*.config.ts',
        '**/*.d.ts',
        // webpack.widgets.config.cjs and build.mjs are build tooling, not
        // covered by these tests (no unit tests exercise a bundler config).
        'webpack.widgets.config.cjs',
        'build.mjs',
      ],

      // Coverage was measured here for a long time and never enforced, which
      // means it could only drift downward without anything objecting. These
      // numbers are the floor as it stands, rounded down — they are not a
      // target, and nothing here should ever be lowered to make a change pass.
      //
      // TWO LEVELS, deliberately. A single global number would let the
      // well-covered modules rot while thin CLI wrappers were added around
      // them, because the global average barely moves either way. The second
      // block holds the line where the real logic lives.
      //
      // Not using `autoUpdate`: it would rewrite this file on any run that
      // improved, which turns a deliberate floor into a moving one and makes
      // the ratchet invisible in review.
      thresholds: {
        // Everything, including cli/ (thin argv wrappers) and widget/ (browser
        // entry points that need a DOM). Both are low by nature, and the note
        // in the tracker explains why that is accepted rather than hidden.
        statements: 64,
        branches: 56,
        functions: 63,
        lines: 64,

        // The root modules: submitters, tree builders, oracles, the
        // eligibility checker. This is the code that decides what a
        // transaction says and who gets a leaf, and it is held far higher.
        '*.ts': {
          statements: 82,
          branches: 72,
          functions: 80,
          lines: 83,
        },
      },
    },
  },
});
