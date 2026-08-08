// ============================================================================
// Noctis Protocol — publish a validator as a CIP-33 reference script
// ============================================================================
// A one-time deposit per validator, not per launch: every Noctis validator is
// unparameterized, so one published output serves every launch of that tier
// forever, and the ada stays recoverable because the output pays back to the
// publishing wallet.
//
// This has to be re-run whenever the validator changes. A validator's hash is
// its identity, so a change moves the address every launch lives at and leaves
// the old published script pointing at nothing spendable. The pointer this
// prints is what a spender must be configured with; a spender handed a stale
// one refuses to build rather than producing a transaction the node rejects
// for reasons that name neither the pointer nor the validator.
//
// Run with `--dry-run` first. It builds and measures the real transaction,
// reports the pointer a real run would produce, and submits nothing.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import type { CurveNetwork } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID } from '../reference-script.js';
import { publishReferenceScript } from '../reference-script-publisher.js';
import { jsonSafe, loadPlutusBlueprint, loadValidatorCbor, parseJsonStdin, readStdin, requireField } from './cli-io.js';

declare const __dirname: string;

interface PublishReferenceScriptInput {
  network: CurveNetwork;
  /** The validator's title in plutus.json, e.g. `bonding_curve.bonding_curve.spend`. */
  validatorTitle: string;
  /** Publishing wallet's BIP-39 mnemonic. The deposit returns to this wallet. */
  publisherMnemonic: string;
  blockfrostProjectId: string;
  /** Build and measure without submitting. */
  dryRun?: boolean;
}

async function main() {
  const input = parseJsonStdin<PublishReferenceScriptInput>(await readStdin());

  const network = requireField(input, 'network');
  const validatorTitle = requireField(input, 'validatorTitle');
  const publisherMnemonic = requireField(input, 'publisherMnemonic');
  const blockfrostProjectId = requireField(input, 'blockfrostProjectId');

  const compiledScriptCbor = loadValidatorCbor(loadPlutusBlueprint(__dirname), validatorTitle);

  const provider = new BlockfrostProvider(blockfrostProjectId);
  const wallet = new MeshWallet({
    networkId: MESH_NETWORK_ID[network],
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: publisherMnemonic.trim().split(/\s+/) },
  });

  const result = await publishReferenceScript({
    network,
    compiledScriptCbor,
    label: validatorTitle,
    provider,
    wallet,
    dryRun: input.dryRun ?? false,
  });

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
