// ============================================================================
// Noctis Zone — is the blueprint on disk the one this bundle was built for?
// ============================================================================
// WHY THIS EXISTS
// The CLI bundles read `contracts/cardano/plutus.json` at RUNTIME, from a path
// relative to wherever they are installed. On the live server that is a plain
// directory the bundles are copied into — it is not git-tracked, so a push
// updates nothing there, and the blueprint has to be copied across by hand
// alongside the bundles.
//
// When only one of the two is copied, nothing complains. The bundle builds a
// transaction against whatever script the stale blueprint describes, and the
// node rejects it for a reason that names neither the blueprint nor the
// validator. That has already cost real days once, with a security fix and a
// whole validator missing from the deployed blueprint the entire time.
//
// A validator's hash IS its identity — change the validator and its address
// moves — so comparing hashes answers exactly the question that matters:
// "is the script this bundle expects the script this blueprint describes?"
//
// WHY NOT HASH THE FILE
// A blueprint checked out on Windows and one copied to a Linux server can
// differ by line endings alone while describing identical scripts. Hashing the
// bytes would cry wolf on every deploy. This reads the `hash` field the
// compiler already puts on each validator, sorts by title, and hashes that —
// formatting, key order and line endings cannot move it, and a real change to
// any validator always does.
//
// THE TWIN: build.mjs computes this same value at build time and injects it
// into every bundle. The two implementations are deliberately tiny and each
// points at the other; `blueprint-fingerprint.test.ts` pins the algorithm
// against a fixture so neither can drift silently.
// ============================================================================

import { createHash } from 'node:crypto';

export interface FingerprintableBlueprint {
  validators: Array<{ title: string; hash?: string }>;
}

/**
 * A stable identifier for the set of scripts a blueprint describes.
 *
 * Sorted by title so the compiler's emission order cannot change it, and
 * built from `title:hash` pairs so a renamed validator is as visible as a
 * recompiled one.
 *
 * A validator with no `hash` contributes the empty string rather than being
 * skipped — being absent and being unhashed are different states, and
 * collapsing them would hide a malformed blueprint.
 */
export function blueprintFingerprint(blueprint: FingerprintableBlueprint): string {
  const lines = blueprint.validators
    .map((v) => `${v.title}:${v.hash ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

/** Injected by build.mjs. Absent when running from source (tsx, vitest). */
declare const __BLUEPRINT_FINGERPRINT__: string | undefined;

/**
 * Throws if the blueprint on disk is not the one this bundle was built for.
 *
 * Silent when running from source — there is no build step to disagree with,
 * and the file being read IS the file the code was written against.
 */
export function assertBlueprintMatchesBuild(blueprint: FingerprintableBlueprint, blueprintPath: string): void {
  const expected = typeof __BLUEPRINT_FINGERPRINT__ === 'string' ? __BLUEPRINT_FINGERPRINT__ : undefined;
  if (!expected) {
    return;
  }
  const actual = blueprintFingerprint(blueprint);
  if (actual === expected) {
    return;
  }
  throw new Error(
    'This CLI was built against a different set of compiled validators than the blueprint it just read.\n' +
      `  blueprint: ${blueprintPath}\n` +
      `  expected fingerprint: ${expected}\n` +
      `  actual fingerprint:   ${actual}\n` +
      `Every validator's address is derived from its hash, so continuing would build a transaction ` +
      'against a script that is not the one deployed. Copy the matching plutus.json and the CLI bundles ' +
      'across together — they are a pair, and this directory is not git-tracked, so a push does not ' +
      'update either of them.',
  );
}
