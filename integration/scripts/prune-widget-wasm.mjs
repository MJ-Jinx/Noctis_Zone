// Removes stale content-hashed .wasm assets from the widget output directory.
//
// WHY THIS EXISTS
// webpack emits each WebAssembly module as its own file named by content hash
// ([hash].wasm), so browsers can cache it indefinitely and a content change
// busts that cache automatically. When the content changes, a NEW file appears
// — but webpack does not remove the old one, because webpack.widgets.config.cjs
// deliberately sets `clean: false`: the output directory also holds the theme's
// hand-written JS (main.js, launch.js, darkveil.js, ...) that a blanket clean
// would destroy.
//
// The result is that every rebuild touching wasm leaves the previous generation
// behind, tracked in git forever. Left alone this grew to 15 dead files / ~38 MB
// before it was noticed. The theme deploys to live by `git pull`, so that dead
// weight ships on every clone and deploy.
//
// WHY A POST-BUILD SCRIPT RATHER THAN A WEBPACK PLUGIN
// The widgets build is an ARRAY of four configs sharing one output directory.
// A per-compiler `done`/`afterEmit` hook fires once per config, so a compiler
// finishing early would delete .wasm files a sibling config still needs and has
// not emitted yet. Running once, after the whole build, has no such ordering
// hazard.
//
// SAFETY
// Only ever deletes files matching *.wasm inside the widgets output directory,
// and only when NO current .bundle.js references that file's hash. Anything it
// cannot positively prove is unreferenced is left alone. If no bundles are
// found at all it does nothing, rather than assuming everything is dead.

import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Single source of truth for the output path — read it from the webpack config
// rather than duplicating it, so the two can never drift apart.
const configs = require('../webpack.widgets.config.cjs');
const outDir = (Array.isArray(configs) ? configs[0] : configs)?.output?.path;

if (!outDir) {
  console.error('prune-widget-wasm: could not resolve output.path from webpack.widgets.config.cjs');
  process.exit(1);
}

const files = readdirSync(outDir);
const bundles = files.filter((f) => f.endsWith('.bundle.js'));
const wasm = files.filter((f) => f.endsWith('.wasm'));

if (bundles.length === 0) {
  console.log('prune-widget-wasm: no .bundle.js found — nothing to check against, leaving everything alone.');
  process.exit(0);
}

// Concatenate every bundle once; a hash referenced by any of them is live.
const haystack = bundles.map((b) => readFileSync(join(outDir, b), 'utf8')).join('\n');

let removed = 0;
let freed = 0;
for (const w of wasm) {
  const hash = w.replace(/\.wasm$/, '');
  if (haystack.includes(hash)) continue;
  const full = join(outDir, w);
  freed += statSync(full).size;
  unlinkSync(full);
  removed += 1;
  console.log(`  removed ${w}`);
}

console.log(
  removed === 0
    ? `prune-widget-wasm: ${wasm.length} wasm asset(s), all referenced — nothing to prune.`
    : `prune-widget-wasm: removed ${removed} unreferenced asset(s), freed ${(freed / 1024 / 1024).toFixed(1)} MB. ${wasm.length - removed} still referenced.`,
);
