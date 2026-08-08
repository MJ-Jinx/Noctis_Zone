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
//   1. The launch's thread NFT must be present. Wave 2 put one on every state
//      UTXO precisely so a reader has something to check beyond the datum.
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

import type { UTxO } from '@lucid-evolution/lucid';
import { Data } from '@lucid-evolution/lucid';

import { type ThreadNftRole, threadNftAssetName } from './tier-a-schemas.js';

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
 * The one UTXO at `address` belonging to `launchIdHex` in the given role.
 *
 * @throws if none match, or if more than one does.
 */
export function selectLaunchUtxo<T extends LaunchScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  role: ThreadNftRole,
  schema: unknown,
): FoundLaunchUtxo<T> {
  const assetName = threadNftAssetName(role, launchIdHex);
  const matches: FoundLaunchUtxo<T>[] = [];

  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    let decoded: T;
    try {
      decoded = Data.from<T>(utxo.datum, schema as never);
    } catch {
      continue; // not this datum shape — someone else's UTXO at a shared address
    }
    if (decoded.launch_id !== launchIdHex) continue;
    // The token has to actually be there. `thread_nft_policy` is a plain hex
    // policy id and the asset name encodes the role and the launch, so the unit
    // is their concatenation.
    const unit = decoded.thread_nft_policy + assetName;
    if ((utxo.assets[unit] ?? 0n) !== 1n) continue;
    matches.push({ utxo, datum: decoded });
  }

  if (matches.length === 0) {
    throw new Error(
      `No UTXO at ${address} carries launch ${launchIdHex}'s ${role} thread NFT. ` +
        'Either the launch was never minted, or its state UTXO has been spent.',
    );
  }
  if (matches.length > 1) {
    const refs = matches.map((m) => `${m.utxo.txHash}#${m.utxo.outputIndex}`).join(', ');
    throw new Error(
      `${matches.length} UTXOs at ${address} claim launch ${launchIdHex} in the ${role} role: ${refs}. ` +
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
