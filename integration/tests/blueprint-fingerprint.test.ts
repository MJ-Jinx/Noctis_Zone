// The blueprint fingerprint, and the properties the deploy check depends on.
//
// WHY THIS IS PINNED
// The algorithm has a twin in build.mjs, which computes the value at build time
// and injects it into every CLI bundle. The two are separate implementations in
// separate languages of the same three lines, so nothing but a pinned fixture
// stops one from drifting away from the other — and if they drift, every
// deployed CLI refuses every blueprint, or worse, accepts a stale one.
//
// If a value below changes, the algorithm changed. Change build.mjs to match in
// the same commit, or put it back.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blueprintFingerprint, type FingerprintableBlueprint } from '../blueprint-fingerprint.js';

const FIXTURE: FingerprintableBlueprint = {
  validators: [
    { title: 'b.b.spend', hash: 'bbbb' },
    { title: 'a.a.spend', hash: 'aaaa' },
  ],
};

/** What build.mjs computes, written out longhand rather than imported. */
function theTwinsAlgorithm(blueprint: FingerprintableBlueprint): string {
  const lines = blueprint.validators
    .map((v) => `${v.title}:${v.hash ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

describe('blueprintFingerprint', () => {
  it('matches the algorithm build.mjs implements', () => {
    // Not a tautology: this spells the twin out independently, so a change to
    // the exported function that build.mjs did not receive shows up here.
    expect(blueprintFingerprint(FIXTURE)).toBe(theTwinsAlgorithm(FIXTURE));
  });

  it('is pinned to a known value', () => {
    expect(blueprintFingerprint(FIXTURE)).toBe(
      createHash('sha256').update('a.a.spend:aaaa\nb.b.spend:bbbb', 'utf8').digest('hex'),
    );
  });

  it('ignores the order validators are emitted in', () => {
    // The compiler's emission order is not a promise, and a reordering that
    // moved the fingerprint would fail every deployed CLI for no real reason.
    const reversed: FingerprintableBlueprint = { validators: [...FIXTURE.validators].reverse() };
    expect(blueprintFingerprint(reversed)).toBe(blueprintFingerprint(FIXTURE));
  });

  it('moves when any validator hash moves', () => {
    // The property the whole check rests on: a validator's hash is its address.
    const changed: FingerprintableBlueprint = {
      validators: [
        { title: 'b.b.spend', hash: 'bbbb' },
        { title: 'a.a.spend', hash: 'aaac' },
      ],
    };
    expect(blueprintFingerprint(changed)).not.toBe(blueprintFingerprint(FIXTURE));
  });

  it('moves when a validator is renamed, even at the same hash', () => {
    const renamed: FingerprintableBlueprint = {
      validators: [
        { title: 'b.b.spend', hash: 'bbbb' },
        { title: 'a.a.mint', hash: 'aaaa' },
      ],
    };
    expect(blueprintFingerprint(renamed)).not.toBe(blueprintFingerprint(FIXTURE));
  });

  it('moves when a validator is added or removed', () => {
    const extra: FingerprintableBlueprint = {
      validators: [...FIXTURE.validators, { title: 'c.c.spend', hash: 'cccc' }],
    };
    expect(blueprintFingerprint(extra)).not.toBe(blueprintFingerprint(FIXTURE));
  });

  it('distinguishes a missing hash from an empty one being absent entirely', () => {
    // Collapsing these would let a malformed blueprint pass as a well-formed
    // one describing the same scripts.
    const unhashed: FingerprintableBlueprint = { validators: [{ title: 'a.a.spend' }] };
    const empty: FingerprintableBlueprint = { validators: [] };
    expect(blueprintFingerprint(unhashed)).not.toBe(blueprintFingerprint(empty));
  });

  it('is not moved by formatting, key order or line endings', () => {
    // The reason this hashes fields rather than the file's bytes: a Windows
    // checkout and a Linux server copy differ that way while describing
    // identical scripts, and crying wolf on every deploy trains people to
    // ignore it.
    const roundTripped: FingerprintableBlueprint = JSON.parse(
      JSON.stringify({ validators: FIXTURE.validators.map((v) => ({ hash: v.hash, title: v.title })) }),
    );
    expect(blueprintFingerprint(roundTripped)).toBe(blueprintFingerprint(FIXTURE));
  });
});

describe('the real blueprint', () => {
  it('every validator carries the hash the fingerprint reads', async () => {
    // If the compiler ever stopped emitting `hash`, the fingerprint would
    // quietly become a hash of titles alone and stop detecting a recompile.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const blueprint = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
    ) as FingerprintableBlueprint;

    expect(blueprint.validators.length).toBeGreaterThan(0);
    for (const v of blueprint.validators) {
      expect(v.hash, `${v.title} has no hash`).toMatch(/^[0-9a-f]{56}$/);
    }
  });
});
