// ============================================================================
// Noctis Protocol — Raw compactc Output -> compact-js Effect Adapter
// ============================================================================
// Every `compactc`-generated contract class (see any
// contracts/midnight/compiled/<psm>/contract/index.d.ts) declares a fourth
// field, `impureCircuits`, alongside the three that
// @midnight-ntwrk/compact-js's `effect/Contract` interface actually requires
// (`witnesses`, `circuits`, `provableCircuits`, `initialState`). That's not a
// bug in our codegen — the README for compact-js confirms raw compactc
// output is exactly what it's meant to consume.
//
// The problem is `CompiledContract<in out C, ...>` (compact-js
// effect/CompiledContract.d.ts:19) declares its contract type parameter
// INVARIANT. Invariance means TypeScript checks assignability in both
// directions — and while our concrete class trivially satisfies compact-js's
// narrower `Contract<PS, W>` interface (extra fields are fine going one
// way), the reverse direction fails: compact-js's own generic
// `Contract.Any` (= `Contract<any>`) does not carry `impureCircuits`, so it
// cannot be assigned back into our concrete class's type. Confirmed via
// `npx tsc` against @midnight-ntwrk/compact-js@2.5.1 +
// @midnight-ntwrk/midnight-js-contracts@4.1.1 (2026-07-09) — this is a type
// declaration gap in compact-js, not a real structural incompatibility: the
// underlying JS object has every field `CompiledContract.make()` needs at
// runtime.
//
// `asEffectContract` documents and contains the one unsafe cast this
// requires, narrowing our concrete class's declared type down to exactly
// what compact-js's `Contract<PS, W>` interface expects before handing it to
// `CompiledContractOps.make()`. Nothing about the runtime object changes —
// `impureCircuits` is still there, `compact-runtime` still uses it the same
// way it always has.
//
// KNOWN LIMITATION (confirmed empirically, 2026-07-09): there is no way,
// with this SDK version pairing, to get BOTH a clean `deployContract`/
// `findDeployedContract` call AND fully per-circuit-typed `.callTx`. Every
// variant tried — pinning `W` to our own named-method witnesses interface,
// `Omit<RawInstance, 'impureCircuits'>` instead of the fully generic
// `EffectContract<PS>` — reintroduces the SAME invariance failure on some
// OTHER field (`witnesses`, `circuits`, `provableCircuits`), because
// `Contract.Any`'s fields are all generic `Record<string, X>` shapes and
// `CompiledContract<in out C,...>`'s invariance requires bidirectional
// structural equality against whatever `C` gets inferred as. Widening `C`
// down to `EffectContract<PS>` (this file's approach) is what actually
// compiles; the cost is `.callTx.<anything>(...anyArgs)` type-checks
// unconditionally — TypeScript will NOT catch a wrong circuit name or wrong
// argument shape at this layer. Runtime correctness for every `.callTx`
// call in integration/midnight-client.ts depends on matching each PSM's
// real compiled signature by hand (see each
// contracts/midnight/compiled/<psm>/contract/index.d.ts) — verified once
// per call site there, not enforced by the compiler here. This is a real
// SDK-maturity gap, not a mistake in this file.
// ============================================================================

import type {
  Contract as EffectContract,
  Witnesses as EffectWitnesses,
} from '@midnight-ntwrk/compact-js/effect/Contract';

/**
 * Narrow a raw compactc-generated `Contract` class down to the constructor
 * shape @midnight-ntwrk/compact-js's `CompiledContract.make()` expects.
 * Use this instead of passing the compiled `Contract` class directly.
 *
 * Only parameterized by `PS` (private state), not by our own named-method
 * witnesses interface — the return type's constructor parameter is
 * compact-js's own generic `Witnesses<PS>` (`Record<string, Witness<PS>>`),
 * the same shape `Contract.Any` defaults to. That's deliberate: it's what
 * makes the invariant `C` in `CompiledContract<in out C, ...>` line up with
 * `Any` on both sides (confirmed empirically — pinning `W` to our specific
 * named-method interface here, instead of the generic default, reintroduces
 * the exact invariance failure this file exists to route around). Our
 * actual witnesses OBJECT (with real named methods) is still checked for a
 * structural match against that generic Record shape later, at
 * `CompiledContractOps.withWitnesses(...)` — nothing is lost, since
 * `.callTx.<circuitName>(...)`'s argument/return types come from `C`'s
 * `provableCircuits`, not from `W`.
 *
 * `ctor` is intentionally typed `unknown` — every compactc-generated
 * `Contract` class has a structurally different `initialState(...)` (one
 * positional arg per constructor param declared in the .compact source), so
 * there is no single non-`any` constructor shape that fits all 8 PSMs. The
 * cast is the whole point of this function (see file header); `PS` on the
 * return type is what keeps every call site after this one fully typed.
 */
export function asEffectContract<PS>(ctor: unknown): {
  new (witnesses: EffectWitnesses<PS>): EffectContract<PS>;
} {
  return ctor as { new (witnesses: EffectWitnesses<PS>): EffectContract<PS> };
}
