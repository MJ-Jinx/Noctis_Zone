// ============================================================================
// Noctis Zone — one-shot CLI wrapper around buildDvAllocationTree
// ============================================================================
// Governor-side: after DarkVeil closes, computes the Merkle root
// AnchorDvAllocationRoot anchors on bonding_curve_tier_b.ak — pure
// off-chain computation (blake2b_256 over real per-buyer allocation
// entries, see dv-allocation-tree.ts), no network/live-infra dependency,
// same reasoning as build-allowlist-tree.ts's own header comment.
//
// Input: JSON on stdin — { "entries": [{ "vkhHex": "<hex>", "dvAmount":
// "<decimal string>", "saltHex": "<hex>" }, ...] } — one entry per real
// DarkVeil buyer (governor computes this list off-chain from
// eligibility_gate.compact's dvTokensPurchased map, per the
// documented Cardano-wallet<->Midnight-identity trust boundary — this CLI
// only does the tree math). Order matters: leaf index == array index.
// Output: { "root": "<hex>", "proofs": [{ "vkhHex": "...", "dvAmount":
// "...", "proof": [{ "siblingHex": "...", "goesLeft": bool }, ...] }, ...] }.
//
// This CLI's output contains EVERY buyer's own proof in one place — fine
// for the governor's own use (anchoring the root needs only `root`; this
// full output is the governor's private working record). It is NOT what a
// buyer-facing endpoint should ever return directly — see
// get-dv-allocation-proof.ts, which serves exactly one buyer's own triple,
// for that purpose (the actual fix).
// ============================================================================

import { buildDvAllocationTree, type DvAllocationEntry } from '../dv-allocation-tree.js';
import { parseJsonStdin, readStdin } from './cli-io.js';

interface InputEntry {
  vkhHex: string;
  dvAmount: string;
  saltHex: string;
}

interface Input {
  entries: InputEntry[];
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error('entries must be a non-empty array.');
  }

  const entries: DvAllocationEntry[] = input.entries.map((e) => ({
    vkh: fromHex(e.vkhHex),
    dvAmount: BigInt(e.dvAmount),
    salt: fromHex(e.saltHex),
  }));

  const tree = buildDvAllocationTree(entries);

  const proofs = input.entries.map((e, i) => ({
    vkhHex: e.vkhHex,
    dvAmount: e.dvAmount,
    // Position in the tree, which is also the registrant's bit in the curve's
    // claimed_bits nullifier, and is hashed into their leaf. The claimer must
    // present it, so it has to be handed back with the proof.
    leafIndex: i,
    proof: tree.getProof(i).map((step) => ({
      siblingHex: toHex(step.sibling),
      goesLeft: step.goesLeft,
    })),
  }));

  process.stdout.write(
    JSON.stringify({
      root: toHex(tree.root),
      proofs,
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
