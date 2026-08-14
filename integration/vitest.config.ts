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

      // Floors are per AREA, and there is deliberately no global number.
      //
      // There used to be one, and it could only ever measure the wrong thing.
      // A global average is taken over a denominator whose COMPOSITION changes:
      // cli/ is ~96% uncovered by design — every file there is main() plus
      // stdin parsing around a submitter that is itself tested — so adding
      // operator tooling drags the average down without anything getting
      // worse. Eight CLIs added over two days moved it from 65.5% to 60.2% and
      // failed CI on 22 consecutive pushes, none of which was a quality
      // regression. A gate that fires on "you added a CLI" trains people to
      // silence it.
      //
      // Each floor below is over a fixed set of files, so it moves only when
      // that area's own coverage moves. They are the floor as it stands,
      // rounded down — not targets, and nothing here should be lowered to make
      // a change pass. Raising one after real work is the point.
      //
      // NOTE FOR REVIEW: a NEW top-level directory under integration/ matches
      // none of these globs and would therefore be ungated. Adding one means
      // adding its floor here too.
      //
      // Not using `autoUpdate`: it would rewrite this file on any run that
      // improved, which turns a deliberate floor into a moving one and makes
      // the ratchet invisible in review.
      thresholds: {
        // The root modules: submitters, tree builders, oracles, the
        // eligibility checker, the chain client. This is the code that decides
        // what a transaction says and who gets a leaf, and it is the real gate.
        // Raised 2026-08-14 from 82/72/80/83 after covering the ADA/USD source,
        // the Blockfrost client, the failure describer and the trade-history
        // walk.
        '*.ts': {
          statements: 85,
          branches: 78,
          functions: 85,
          lines: 86,
        },

        // Browser entry points. Low because they need a DOM the unit suite does
        // not provide, but they hold real logic — claim bundling, wallet
        // session handling — so they are gated rather than waved through.
        'widget/**': {
          statements: 19,
          branches: 23,
          functions: 14,
          lines: 19,
        },

        // cli/ is deliberately MEASURED BUT NOT GATED. It still appears in the
        // report, so its coverage is visible and reviewable; it just does not
        // fail the build. A floor here could only ever punish adding a wrapper,
        // since a new one arrives at 0% by nature. What these files actually
        // do — argv in, one submitter call, JSON out — is exercised end to end
        // by real Preprod runs rather than by unit tests, and the logic they
        // wrap is covered above.
      },
    },
  },
});
