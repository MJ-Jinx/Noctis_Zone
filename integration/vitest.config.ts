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
    },
  },
});
