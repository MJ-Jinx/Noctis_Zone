// ============================================================================
// Noctis Protocol — shared CLI I/O helpers
// ============================================================================
// Extracted from ~20 near-identical inline copies across integration/cli/
// *.ts (each a standalone stdin-JSON-in/stdout-JSON-out script invoked
// one-shot by PHP's proc_open) so this logic is unit-testable directly —
// see integration/tests/cli-io.test.ts. Pure extraction, no behavior
// change: every function here matches an exact pattern already present in
// the real CLI files, verified file-by-file before this module existed.
//
// Every CLI bundles independently via esbuild (see build.mjs — all configs
// use `bundle: true`), so importing this module inlines its code into each
// CLI's own single output file, same as when the logic was written inline.
// `loadPlutusBlueprint` deliberately takes the CALLING file's own
// `__dirname` rather than using this module's own, because after CJS
// bundling there is exactly one real `__dirname` (the bundle's own
// directory) regardless of which source module a `__dirname` reference
// originated from — confirmed against build.mjs's real config: every CLI
// that loads plutus.json bundles to CJS format specifically (for an
// unrelated reason — a Lucid Evolution transitive dep needs a real,
// non-ESM `__dirname` for its own WASM loading — but it has the convenient
// side effect of making `__dirname` a genuine runtime value here too).
//
// Deliberately NOT extracted: the final `main().catch(...)` wrapper. A
// survey of all 32 files found 6 real variants and 5 files with genuinely
// different observable behavior (error output shape, hard `process.exit(1)`
// vs `process.exitCode = 1`, debug-logging depth) — collapsing those into
// one generic wrapper risks silently changing production error-handling
// behavior for real money-moving CLIs. Each file keeps its own final
// wrapper, calling the shared helpers below for the parts that ARE
// identical everywhere.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

/** Reads all of stdin as a UTF-8 string. Identical across all 32 CLI files (2 syntactic variants, same behavior). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON.parse with the exact error message 30/32 CLI files already throw on malformed input. */
export function parseJsonStdin<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }
}

// Three real, distinct truth tables are in use across the CLI scripts for
// "is this required field missing" — kept as separate named functions
// rather than collapsed into one, since they genuinely disagree on whether
// 0 / '' / false count as present. Using the wrong one for a given file
// would be a real behavior change (e.g. rejecting a legitimate 0 value).

/** Rejects a field only if it's falsy AND not the number 0. (10 files' truth table.) */
export function requireFieldsAllowZero<T extends object>(input: T, keys: Array<keyof T>): void {
  for (const key of keys) {
    const value = input[key];
    if (!value && value !== 0) {
      throw new Error(`Missing required field: ${String(key)}`);
    }
  }
}

/** Rejects any falsy value, including 0, '', and false. (10 files' + publish-allowlist-root.ts's truth table.) */
export function requireFieldsFalsy<T extends object>(input: T, keys: Array<keyof T>): void {
  for (const key of keys) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${String(key)}`);
    }
  }
}

/** Rejects only undefined, null, and ''. Accepts 0 and false. (build-tier-a-genesis-datums.ts / check-night-balance.ts's truth table.) */
export function requireFieldsStrict<T extends object>(input: T, keys: Array<keyof T>): void {
  for (const key of keys) {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required field: ${String(key)}`);
    }
  }
}

/**
 * Same truth table as requireFieldsStrict, one field at a time, with an
 * optional action label — matches the byte-identical requireField() already
 * duplicated verbatim in stake-action.ts / tier-b-curve-action.ts /
 * token-metadata-action.ts. Returns `NonNullable<T[K]>` rather than the
 * wider `T[K]` (which would include `| undefined` for an optional input
 * field) — the runtime check above already guarantees a present value, so
 * callers that pass the result straight into e.g. `BigInt(...)` don't need
 * a redundant cast.
 */
export function requireField<T extends object, K extends keyof T>(
  input: T,
  key: K,
  actionLabel?: string,
): NonNullable<T[K]> {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      actionLabel
        ? `Missing required field for action "${actionLabel}": ${String(key)}`
        : `Missing required field: ${String(key)}`,
    );
  }
  return value as NonNullable<T[K]>;
}

/** Recursively converts bigints to strings and Uint8Arrays to hex, so a result object survives JSON.stringify. Uses the Uint8Array-aware superset (stake-action.ts's own variant) as the one canonical version — a strict superset of every other file's plain variant, since none of their result shapes carry a raw Uint8Array today. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** Values are byte-identical everywhere this appears across 20 files. */
export const CARDANO_NETWORK_MAP: Record<'preview' | 'preprod' | 'mainnet', LucidNetwork> = {
  preview: 'Preview',
  preprod: 'Preprod',
  mainnet: 'Mainnet',
};

export interface PlutusBlueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}

/** Loads contracts/cardano/plutus.json relative to the CALLING CLI's own __dirname — see this module's own header for why that's safe post-bundling. */
export function loadPlutusBlueprint(callerDirname: string): PlutusBlueprint {
  const blueprintPath = join(callerDirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  return JSON.parse(readFileSync(blueprintPath, 'utf8'));
}

/** Finds one compiled validator's CBOR by its real plutus.json title, matching every CLI's existing error-message text exactly. */
export function loadValidatorCbor(blueprint: PlutusBlueprint, title: string): string {
  const entry = blueprint.validators.find((v) => v.title === title);
  if (!entry) {
    throw new Error(`${title} not found in plutus.json.`);
  }
  return entry.compiledCode;
}
