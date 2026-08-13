// ============================================================================
// Noctis Protocol — allowlist bundle for a DarkVeil launch
// ============================================================================
// Turns a set of server-held wallets into the two things a DarkVeil launch
// needs: the `allowlistRoot_` sealed at deploy, and one membership proof per
// registrant for `registerForDarkVeil` to present later.
//
// This exists as one step because the two halves must agree and are easy to
// pair up wrongly. `registerForDarkVeil` identifies its caller as
// `deriveUserPublicKey(getUserSecret(), launchId)` and derives the allowlist
// leaf from THAT, in-circuit. So a bundle is only valid for one launch id, and
// building the tree from wallet addresses, seeds, or an identity derived for a
// different launch produces proofs that fail with "Invalid allowlist proof" —
// a message that points at the tree rather than at the identity that was wrong.
//
// The launch id is therefore required, not defaulted: a bundle that silently
// used the wrong one would look correct until every registration failed.
//
// Input:  {"launchIdHex":"<64 hex>",
//          "wallets":[{"role":"buyer_2","seedHex":"<64 hex>"}, …]}
// Output: {"launchIdHex":"…","allowlistRootHex":"…","allowlistSize":n,
//          "entries":[{"role":"…","pubKeyHex":"…",
//                      "proof":[{"siblingHex":"…","goesLeft":bool}, …]}, …]}
//
// Seeds arrive on stdin and no secret is written to the output: the bundle
// carries public identities and proofs only, so it is safe to hand to whatever
// runs the registrations. Each registrant's witness secret is re-derived from
// its own seed at registration time.
// ============================================================================

import { buildAllowlistTree, hashAllowlistLeaf } from '../../packages/zk-proofs/src/eligibility-gate.js';
import { deriveLaunchIdentity } from '../midnight-user-identity.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface WalletInput {
  role: string;
  seedHex: string;
}

interface Input {
  launchIdHex: string;
  wallets: WalletInput[];
}

function fromHex32(hex: string, field: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`${field} must be 32 bytes as 64 hex characters, got ${clean.length}.`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['launchIdHex']);

  if (!Array.isArray(input.wallets) || input.wallets.length === 0) {
    throw new Error('wallets must be a non-empty array.');
  }

  const roles = input.wallets.map((w) => w.role);
  const duplicates = roles.filter((r, i) => roles.indexOf(r) !== i);
  if (duplicates.length > 0) {
    // Two leaves for one registrant would inflate the registrant count the
    // minimum-participant floor is checked against, which is exactly the
    // padding that floor exists to prevent.
    throw new Error(`Duplicate roles in wallets: ${[...new Set(duplicates)].join(', ')}.`);
  }

  const launchId = fromHex32(input.launchIdHex, 'launchIdHex');

  const identities = input.wallets.map((wallet) => ({
    role: wallet.role,
    pubKey: deriveLaunchIdentity(fromHex32(wallet.seedHex, `wallets[${wallet.role}].seedHex`), launchId),
  }));

  const seen = new Map<string, string>();
  for (const { role, pubKey } of identities) {
    const hex = toHex(pubKey);
    const other = seen.get(hex);
    if (other) {
      // Distinct seeds cannot collide here, so this means two entries share a
      // seed — one wallet registering twice under two names.
      throw new Error(`${role} and ${other} derive the same identity; they share a seed.`);
    }
    seen.set(hex, role);
  }

  const tree = buildAllowlistTree(identities.map(({ pubKey }) => hashAllowlistLeaf(pubKey)));

  const entries = identities.map(({ role, pubKey }, index) => ({
    role,
    pubKeyHex: toHex(pubKey),
    proof: tree.getProof(index).map((entry) => ({
      siblingHex: toHex(entry.sibling),
      goesLeft: entry.goesLeft,
    })),
  }));

  process.stdout.write(
    `${JSON.stringify(
      jsonSafe({
        launchIdHex: toHex(launchId),
        allowlistRootHex: toHex(tree.root),
        allowlistSize: entries.length,
        entries,
      }),
    )}\n`,
  );
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
