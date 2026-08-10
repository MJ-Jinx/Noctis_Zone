// launch-utxo-lookup.ts — one way to find a launch's own script UTXO.
//
// Every validator here is unparameterized, so all launches of a given kind
// share one script address and a UTXO's datum is authored by whoever created
// it. Selecting on the datum's `launch_id` alone therefore selects on a claim,
// not on evidence, and the shape this module replaces also returned the FIRST
// match — so a second UTXO claiming the same launch was silently ignored, and
// which of the two got used depended on the order the provider returned them.
//
// Two rules here:
//
//   1. A token only the genuine launch can hold must be present. Wave 2 put a
//      thread NFT on every singleton state UTXO precisely so a reader has
//      something to check beyond the datum; the CIP-68 reference NFT plays the
//      same part for token metadata.
//   2. If more than one UTXO matches, refuse. Refusing is the point: a caller
//      that cannot tell which UTXO is the real one must not pick one anyway.
//      A loud failure is recoverable; building against the wrong UTXO is not.
//
// KNOWN LIMIT, stated plainly: the policy id is read from the datum being
// checked, so a UTXO carrying a self-authored datum naming the forger's own
// policy, plus a token minted under it, satisfies rule 1. What it cannot do is
// pass rule 2 — it matches alongside the real one, and the lookup refuses. So
// the reachable outcome is a caller that stops, never a caller that proceeds
// against a planted UTXO. Closing rule 1 fully means taking the expected policy
// id from the caller's own record of the launch rather than from the datum,
// which is a config change across every submitter and CLI entry point.
//
// THREE ENTRY POINTS, ONE CORE. They differ only in how the launch's datum is
// reached and which token authenticates it — the matching and the refusal are
// shared, so an improvement to either reaches all of them at once. Each entry
// point names its authenticator explicitly rather than deriving one, because
// "what proves this UTXO is the real one" is the whole question this module
// answers and it should never be implicit.

import type { UTxO } from '@lucid-evolution/lucid';
import { Data } from '@lucid-evolution/lucid';

import { cip68BaseName, cip68ReferenceAssetName, type ThreadNftRole, threadNftAssetName } from './tier-a-schemas.js';

/** The minimum a datum must expose for this module to authenticate its UTXO. */
export interface LaunchScopedDatum {
  launch_id: string;
  thread_nft_policy: string;
}

export interface FoundLaunchUtxo<T> {
  utxo: UTxO;
  datum: T;
}

/**
 * Nothing at the address answered to this launch.
 *
 * Its own type because "not there" is legitimate for some readers — a launch
 * genuinely has no metadata UTXO before it is minted — while every other
 * failure this module raises is not. A caller that treats them alike reports
 * an absent launch when the truth is a contested one, or a network outage.
 */
export class LaunchUtxoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchUtxoNotFoundError';
  }
}

/**
 * More than one UTXO answered, and the genuine one cannot be told from the
 * rest. Never legitimate, and never to be swallowed.
 */
export class AmbiguousLaunchUtxoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousLaunchUtxoError';
  }
}

/**
 * How one kind of UTXO is recognised: where its launch datum lives, and which
 * token has to be sitting on it.
 */
interface AuthenticatorSpec<TDatum> {
  /**
   * Reaches the launch's datum from whatever the schema decoded. Returns null
   * when this UTXO is not the shape being looked for at all — a sum-type datum
   * on its other variant, for instance.
   */
  unwrap: (decoded: unknown) => TDatum | null;
  /** The launch id this datum claims. */
  launchIdOf: (datum: TDatum) => string;
  /** Policy id + asset name, hex, that must be present exactly once. */
  unitOf: (datum: TDatum) => string;
  /** Names the token in the not-found error, e.g. "bondingCurve thread NFT". */
  label: string;
}

/**
 * The one UTXO at `address` that both claims `launchIdHex` and carries the
 * token proving it.
 *
 * @throws if none match, or if more than one does.
 */
function selectAuthenticatedUtxo<TDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
  spec: AuthenticatorSpec<TDatum>,
): FoundLaunchUtxo<TDatum> {
  const matches: FoundLaunchUtxo<TDatum>[] = [];

  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    let decoded: unknown;
    try {
      decoded = Data.from(utxo.datum, schema as never);
    } catch {
      continue; // not this datum shape — someone else's UTXO at a shared address
    }
    const datum = spec.unwrap(decoded);
    if (datum === null) continue;
    if (spec.launchIdOf(datum) !== launchIdHex) continue;
    // The token has to actually be there.
    if ((utxo.assets[spec.unitOf(datum)] ?? 0n) !== 1n) continue;
    matches.push({ utxo, datum });
  }

  if (matches.length === 0) {
    throw new LaunchUtxoNotFoundError(
      `No UTXO at ${address} carries launch ${launchIdHex}'s ${spec.label}. ` +
        'Either the launch was never minted, or its state UTXO has been spent.',
    );
  }
  if (matches.length > 1) {
    const refs = matches.map((m) => `${m.utxo.txHash}#${m.utxo.outputIndex}`).join(', ');
    throw new AmbiguousLaunchUtxoError(
      `${matches.length} UTXOs at ${address} claim launch ${launchIdHex}'s ${spec.label}: ${refs}. ` +
        'Refusing to guess which is genuine — exactly one is expected, so this needs investigating ' +
        'before any transaction is built against it.',
    );
  }

  const only = matches[0];
  if (!only) {
    throw new Error('unreachable: matches has exactly one element');
  }
  return only;
}

/**
 * A launch's singleton state UTXO for one of the seven thread-NFT roles.
 *
 * The asset name encodes the role and the launch, so the unit is that name
 * behind the policy the datum names.
 */
export function selectLaunchUtxo<T extends LaunchScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  role: ThreadNftRole,
  schema: unknown,
): FoundLaunchUtxo<T> {
  const assetName = threadNftAssetName(role, launchIdHex);
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => decoded as T,
    launchIdOf: (datum) => datum.launch_id,
    unitOf: (datum) => datum.thread_nft_policy + assetName,
    label: `${role} thread NFT`,
  });
}

/** The `Pool` variant of staking_pool.ak's two-variant datum. */
type StakingPoolVariant<T> = { Pool: [T] };

function isPoolVariant<T>(decoded: unknown): decoded is StakingPoolVariant<T> {
  return typeof decoded === 'object' && decoded !== null && 'Pool' in decoded;
}

/**
 * A launch's staking Pool UTXO.
 *
 * staking_pool.ak's datum is a sum type and both variants live at the same
 * address, so the wrong variant is skipped rather than treated as a decode
 * failure. Only `Pool` is a singleton with a thread NFT — `Position` UTXOs are
 * created one per stake action and deliberately carry no equivalent field,
 * which is why there is no lookup for them here.
 *
 * The variant check is belt-and-braces as things stand: a Position has no
 * `thread_nft_policy`, so no unit built from one can match, and removing this
 * check changes no test. It earns its place against the future — give a
 * Position a policy field and the token check alone would begin accepting one
 * as the pool.
 */
export function selectStakingPoolUtxo<T extends LaunchScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
): FoundLaunchUtxo<T> {
  const assetName = threadNftAssetName('stakingPool', launchIdHex);
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => (isPoolVariant<T>(decoded) ? decoded.Pool[0] : null),
    launchIdOf: (datum) => datum.launch_id,
    unitOf: (datum) => datum.thread_nft_policy + assetName,
    label: 'stakingPool thread NFT',
  });
}

/** What token_metadata.ak's own datum exposes to a reader authenticating it. */
export interface Cip68ScopedDatum {
  extra: {
    launch_id: string;
    token_policy_id: string;
    token_asset_name: string;
  };
}

/**
 * A launch's CIP-68 reference NFT UTXO — its on-chain token metadata.
 *
 * Authenticated by the reference NFT rather than by a thread NFT: token
 * metadata is not one of the seven roles, and it does not need to be. The
 * reference NFT can only exist because launch_token_policy minted it in the
 * launch's genesis transaction, and that policy is a one-shot, so exactly one
 * of these exists per launch forever. This mirrors `carries_own_reference_nft`
 * in token_metadata.ak, which derives the same pair the same way — a reader
 * that checked anything else would accept UTXOs the validator rejects.
 */
export function selectCip68MetadataUtxo<T extends Cip68ScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
): FoundLaunchUtxo<T> {
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => decoded as T,
    launchIdOf: (datum) => datum.extra.launch_id,
    // The fungible token and its reference NFT share one base name behind
    // different CIP-67 labels, so the reference name is the datum's own
    // (fungible) name relabelled.
    unitOf: (datum) =>
      datum.extra.token_policy_id + cip68ReferenceAssetName(cip68BaseName(datum.extra.token_asset_name)),
    label: 'CIP-68 reference NFT',
  });
}
