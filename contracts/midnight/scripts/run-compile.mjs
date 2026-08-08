// Cross-platform entry point for scripts/compile.sh, shared by
// package.json's `compile` script and globalSetup.ts (vitest) so the
// win32-vs-bash platform logic lives in exactly one place.
//
// On win32, plain `bash scripts/compile.sh` resolves `bash` to Git Bash
// (found ahead of the WSL launcher on Windows PATH), which has no access to
// WSL's Linux filesystem or the real `compact` CLI installed there — NOT a
// login-shell-vs-non-login-shell PATH gap, despite what compile.sh's own
// error message suggests. `wsl.exe bash -lc '...'` was verified directly
// (`compact --version` -> `compact 0.5.1`) to reach the real CLI; a bare
// `bash scripts/compile.sh` was reproduced failing with the exact
// documented "resolves to system32\compact.exe" error (found 2026-07-30,
// code-quality audit — this was the first time globalSetup.ts's
// compile-on-Windows path had actually been exercised end to end).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, '..');

if (platform() === 'win32') {
  // -lc: a login shell, so ~/.local/bin (where the real compact CLI lives)
  // is actually on PATH — unlike a bare, non-login `bash script.sh`.
  // wslpath translates the Windows cwd for the `cd` inside the WSL side.
  execFileSync('wsl.exe', ['bash', '-lc', `cd "$(wslpath '${projectDir}')" && bash scripts/compile.sh`], {
    stdio: 'inherit',
  });
} else {
  execFileSync('bash', [join(__dirname, 'compile.sh')], {
    cwd: projectDir,
    stdio: 'inherit',
  });
}
