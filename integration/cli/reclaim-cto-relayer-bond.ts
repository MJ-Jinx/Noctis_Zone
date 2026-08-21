// ============================================================================
// Noctis Zone — cto_governance.ak ReclaimRelayerBond CLI
// Permissionless — the payout destination is fixed by the datum's own
// pending_relayer_key_hash, same "the invariant is the authorization" idiom
// as ExecuteProposal. In practice the relayer themselves calls this, but
// nothing on-chain requires that specific caller. See
// cardano-cto-reclaim-bond-submitter.ts's own header for the full mechanism.
// ============================================================================
// Input: single JSON object on stdin, including the caller's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { CardanoCtoReclaimBondSubmitter } from '../cardano-cto-reclaim-bond-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsAllowZero,
} from './cli-io.js';

declare const __dirname: string;

interface ReclaimBondInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  callerPrivateKeyExtendedHex: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ReclaimBondInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'callerPrivateKeyExtendedHex',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend');

  const submitter = new CardanoCtoReclaimBondSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    callerPrivateKey: input.callerPrivateKeyExtendedHex,
    launchId: hexToBytes(input.launchIdHex),
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.reclaimRelayerBond();
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
