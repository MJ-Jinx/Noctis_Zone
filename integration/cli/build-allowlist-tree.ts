// ============================================================================
// Noctis Zone — one-shot CLI wrapper around buildAllowlistTree
// ============================================================================
// Part of the governor batch pipeline this session added: registerForDarkVeil
// needs a Merkle proof of membership in a governor-published allowlist tree
// (eligibility_gate.compact's verifyAllowlist circuit) — the tree itself is
// pure off-chain computation (persistentHash over caller pubkeys, see
// packages/zk-proofs/src/eligibility-gate.ts's buildAllowlistTree), no
// network/live-infra dependency at all, unlike check-night-balance.ts.
// Reused here as a CLI (not reimplemented in PHP) for the same reason as
// that script: one real, already-tested TS implementation, not two
// divergent copies in two languages.
//
// Input: JSON on stdin — { "pubKeyHexes": ["<64-hex-char>", ...] } — one
// entry per registrant whose off-chain eligibility (checks #1/#2/#4/#5) has
// already passed. Order matters: leaf index == array index, and the
// returned proofs are keyed back to the SAME pubKeyHex, not by index, so
// order stability across calls isn't actually required by the caller.
// Output: { "root": "<hex>", "proofs": [{ "pubKeyHex": "...", "proof": [{
// "siblingHex": "...", "goesLeft": bool }, ...] }, ...] }.
// ============================================================================

import { buildAllowlistTree, hashAllowlistLeaf } from '../../packages/zk-proofs/src/eligibility-gate.js';
import { parseJsonStdin, readStdin } from './cli-io.js';

interface Input {
  pubKeyHexes: string[];
}

function fromHex(hex: string): Uint8Array {
  if (hex.length !== 64) {
    throw new Error(`Expected a 32-byte (64 hex char) pubkey, got ${hex.length} chars: ${hex}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  if (!Array.isArray(input.pubKeyHexes) || input.pubKeyHexes.length === 0) {
    throw new Error('pubKeyHexes must be a non-empty array.');
  }

  const pubKeys = input.pubKeyHexes.map(fromHex);
  const leaves = pubKeys.map(hashAllowlistLeaf);
  const tree = buildAllowlistTree(leaves);

  const proofs = input.pubKeyHexes.map((pubKeyHex, i) => ({
    pubKeyHex,
    proof: tree.getProof(i).map((entry) => ({
      siblingHex: toHex(entry.sibling),
      goesLeft: entry.goesLeft,
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
