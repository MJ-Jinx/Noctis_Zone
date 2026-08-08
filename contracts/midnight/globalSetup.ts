// Vitest globalSetup — compiles all 8 Compact PSMs to compiled/ once,
// before any test file runs, regardless of how vitest was invoked
// (`npm test`, `npx vitest`, `vitest watch`, an IDE's own test runner).
//
// WARN fix (2026-07-30, code-quality audit): previously only `npm test`
// compiled first (via `npm run compile && vitest run`) — any other way of
// launching vitest skipped compilation entirely and hit confusing
// "module not found" errors against compiled/*/contract/index.js instead
// of a clear "run compile first" message. Reuses scripts/run-compile.mjs
// (shared with package.json's own `compile` script) so the win32-vs-bash
// platform logic — plain `bash scripts/compile.sh` never actually worked on
// Windows, see that file's own header for why — lives in exactly one place.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function setup() {
  execFileSync('node', [join(__dirname, 'scripts', 'run-compile.mjs')], {
    cwd: __dirname,
    stdio: 'inherit',
  });
}
