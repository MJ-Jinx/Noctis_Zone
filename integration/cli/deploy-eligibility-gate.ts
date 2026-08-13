// ============================================================================
// Noctis Protocol — deploy the Tier B eligibility gate to Midnight
// ============================================================================
// WHY THIS EXISTS
// `midnight-client.ts` has had seven working, unit-tested deploy methods for
// weeks, and not one of them had a caller outside its tests. There was no
// operational way to put a PSM on chain at all, which is why no launch carried
// a `midnight_contract_address` and why the whole DarkVeil path had never run.
//
// WHO ENDS UP GOVERNING
// The constructor calls exactly ONE witness — `getGovernorSecret()` — and
// writes the key derived from it into `governorKey`, sealed. Whoever deploys
// therefore becomes the governor permanently: only that key can publish an
// allowlist root, open buying, or close DarkVeil. `governorSecretHex` is not a
// convenience credential for this call; it is the launch's governance.
//
// The other four witnesses (user secret, allowlist proof, registrant proof,
// buy nonce) are lazy thunks the constructor never evaluates. They are passed
// as well-formed placeholders rather than empty values so that anything which
// later does read them fails on content rather than on shape.
//
// WHAT THIS REFUSES BEFORE SPENDING ANYTHING
// Every assertion the constructor makes is mirrored here. A deploy that fails
// on chain still costs a transaction and a round trip, and its error names the
// circuit rather than the field. The one rule the contract documents but
// cannot enforce — `walletCap = totalSupply * maxWalletPercent / 100`, because
// Compact circuits cannot divide — is computed here instead of trusted.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { MemoryLevel } from 'memory-level';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { fromHex32, resolveEligibilityGateDeployArgs } from '../eligibility-gate-deploy-args.js';
import { NoctisMidnightClient } from '../midnight-client.js';
import {
  buildServerWallet,
  defaultNetworkConfig,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
} from '../midnight-server-wallet.js';
import { assertZkConfigMatchesBuild } from '../zk-config-fingerprint.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input extends SnapshotCliInput {
  network: MidnightNetwork;
  /** Becomes the contract's permanent governor — see the header. */
  governorSecretHex: string;
  /** Funds the deployment transaction. */
  walletSeedHex: string;
  proofServerUrl: string;
  zkConfigBasePath: string;
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;

  launchIdHex: string;
  allowlistRootHex: string;
  creatorPubKeyHex: string;
  platformAddrHex: string;
  /** The three keys that may attest this contract's allowlist root. */
  allowlistAttestorKeysHex: [string, string, string];
  allowlistThreshold: number;

  /**
   * Circuits this deploy leaves out, to be added afterwards by maintenance
   * update, authorised by a signing key derived from `governorSecretHex` and
   * `launchIdHex`.
   *
   * A deploy writes the contract's whole state at once — the constructor's
   * ledger state plus a verifier key per exported circuit — and a block caps
   * the bytes written in it. Naming circuits here is how a contract whose keys
   * total more than that budget reaches the chain intact.
   *
   * Omitted, the deploy carries every circuit.
   */
  deferCircuits?: string[];

  totalSupply: string;
  maxWalletPercent: number;
  bondAmount: string;
  dvAllocation: string;
  dvPrice: string;
  allowlistSize: number;
  registrationCloseTime: string;
  minDvParticipants: number;
  /**
   * Optional. Omitted, it is computed as totalSupply * maxWalletPercent / 100,
   * which is what the contract documents and cannot check. Supplied, it must
   * equal that — a mismatch is refused rather than silently mis-capping the
   * launch for its whole life.
   */
  walletCap?: string;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  requireFieldsFalsy(input, [
    'network',
    'governorSecretHex',
    'walletSeedHex',
    'proofServerUrl',
    'zkConfigBasePath',
    'launchIdHex',
    'allowlistRootHex',
    'creatorPubKeyHex',
    'platformAddrHex',
    'allowlistAttestorKeysHex',
    'allowlistThreshold',
    'totalSupply',
    'maxWalletPercent',
    'bondAmount',
    'dvAllocation',
    'dvPrice',
    'allowlistSize',
    'registrationCloseTime',
    'minDvParticipants',
  ]);

  // Before the wallet, the network, or anything that costs time or money.
  assertZkConfigMatchesBuild(input.zkConfigBasePath);

  setNetworkId(input.network);

  // Every constructor assertion, mirrored — and walletCap DERIVED rather than
  // trusted, since the contract can only check it is positive. Lifted into
  // eligibility-gate-deploy-args.ts so it is reachable by a test; this file
  // runs main() on import and is not.
  const args = resolveEligibilityGateDeployArgs(input);

  // --- providers ----------------------------------------------------------

  const governorSecret = fromHex32(input.governorSecretHex, 'governorSecretHex');
  const walletSeed = fromHex32(input.walletSeedHex, 'walletSeedHex');

  const netDefaults = defaultNetworkConfig(input.network, input.proofServerUrl);
  const networkConfig = {
    network: input.network,
    provingServerUrl: input.proofServerUrl,
    relayUrl: input.relayUrl ?? netDefaults?.relayUrl,
    indexerHttpUrl: input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl,
    indexerWsUrl: input.indexerWsUrl ?? netDefaults?.indexerWsUrl,
  };
  if (!networkConfig.relayUrl || !networkConfig.indexerHttpUrl || !networkConfig.indexerWsUrl) {
    throw new Error(`relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "${input.network}".`);
  }

  // A deployment is paid for in DUST, and a wallet only sees its DUST once it
  // has replayed far enough to find it. Resuming from a snapshot is what makes
  // that affordable here; without one this wallet replays from chain.
  const serverWallet = await buildServerWallet(
    walletSeed,
    {
      network: networkConfig.network,
      relayUrl: networkConfig.relayUrl,
      provingServerUrl: networkConfig.provingServerUrl,
      indexerHttpUrl: networkConfig.indexerHttpUrl,
      indexerWsUrl: networkConfig.indexerWsUrl,
    },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    const zkConfigProvider = new NodeZkConfigProvider(input.zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-deploy-eligibility-gate',
        signingKeyStoreName: 'noctis-deploy-eligibility-gate-signing',
        // One-shot process: the private state never needs to outlive it.
        privateStoragePasswordProvider: () => 'ephemeral-cli-process',
        accountId: `deploy-eligibility-gate-${input.launchIdHex}`,
        levelFactory: (dbName: string) => new MemoryLevel(dbName as never) as never,
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexerHttpUrl, networkConfig.indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.provingServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    // The governor secret is passed in BOTH positions deliberately: the
    // constructor reads it via getGovernorSecret, and this process has no
    // separate user identity to act as.
    const client = new NoctisMidnightClient({ bytes: governorSecret }, { bytes: governorSecret });

    // Shape-correct placeholders. The constructor evaluates none of these —
    // verified by brace-matching its body, whose only witness call is
    // getGovernorSecret — but a well-formed value fails on content rather than
    // on shape if that ever changes.
    const emptyProof: MerkleProofEntry[] = Array.from({ length: 20 }, () => ({
      sibling: new Uint8Array(32),
      goesLeft: false,
    }));
    const zeroNonce = new Uint8Array(32);

    const record = await client.deployEligibilityGate(
      providers,
      args,
      emptyProof,
      zeroNonce,
      zeroNonce,
      input.deferCircuits ?? [],
    );

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          contractAddress: record.contractAddress,
          launchIdHex: input.launchIdHex,
          walletCap: args.walletCap.toString(),
          ...(record.pendingCircuits ? { pendingCircuits: record.pendingCircuits } : {}),
          note: record.pendingCircuits
            ? 'Record contractAddress against the launch — the whole DarkVeil path keys off it. ' +
              'This contract does not yet answer the circuits in pendingCircuits: add their verifier ' +
              'keys with the same governor secret and launch id before relying on them.'
            : 'Record contractAddress against the launch — the whole DarkVeil path keys off it.',
        }),
      ),
    );
  } finally {
    await serverWallet.shutdown();
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
