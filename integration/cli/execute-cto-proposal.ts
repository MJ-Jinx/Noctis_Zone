// ============================================================================
// Noctis Protocol — cto_governance.ak ExecuteProposal CLI
// Permissionless — the caller's key here is only used as this CLI's
// fee-paying/signing wallet, not for authorization. See
// cardano-cto-execute-proposal-submitter.ts's own header for why this
// redeemer deliberately has no validator-checked signer.
// ============================================================================
// Input: single JSON object on stdin, including the caller's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { CardanoCtoExecuteProposalSubmitter } from '../cardano-cto-execute-proposal-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsAllowZero,
  requireTimestampMs,
} from './cli-io.js';

declare const __dirname: string;

interface ExecuteProposalInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  callerPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ExecuteProposalInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'callerPrivateKeyExtendedHex',
    'currentTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend');

  const submitter = new CardanoCtoExecuteProposalSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    callerPrivateKey: input.callerPrivateKeyExtendedHex,
    launchId: hexToBytes(input.launchIdHex),
  });

  const result = await submitter.executeProposal(
    BigInt(requireTimestampMs(input.currentTimestampMs, 'currentTimestampMs')),
  );
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
