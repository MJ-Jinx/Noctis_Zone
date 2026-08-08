// ============================================================================
// Noctis Protocol — server-side (headless) Midnight wallet + provider bridge
// ============================================================================
// (2026-07-21): registerForDarkVeil needs a governor-published allowlist
// root (updateAllowlistRoot, a governor-only Compact circuit) — but every
// existing wallet/provider bridge in this codebase (widget/midnight-wallet-
// bridge.ts) is built from a CONNECTED BROWSER wallet's dapp-
// connector API. A server-side CLI has no browser wallet to connect to. This
// module builds the two providers a Node process CAN build itself — a real
// WalletProvider + MidnightProvider pair — from a raw 32-byte seed held
// server-side, with no dapp-connector/browser involvement at all.
//
// Verified against real source before writing (not recalled/assumed,
// per this project's own Midnight-SDK discipline): midnight-js-contracts'
// ContractProviders is a plain structural type (MidnightProviders) with no
// hidden runtime dependency on a browser — confirmed by reading
// midnightntwrk/midnight-js's packages/contracts/src/contract-providers.ts
// and packages/types/src/providers.ts directly. The construction pattern
// below (HDWallet -> ShieldedWallet/UnshieldedWallet/DustWallet ->
// WalletFacade) is the midnight-wallet:managing-test-wallets /
// midnight-wallet:wallet-sdk skills' own verified, STABLE-channel pattern
// (@midnight-ntwrk/wallet-sdk-hd@3.0.2, wallet-sdk-facade@4.0.1, etc. — all
// checked against the real npm registry, not the unreleased 5.0.0-beta/
// wallet-sdk@2.0.0-beta channel a first pass at this research surfaced and
// correctly rejected as unsafe to depend on).
//
// WalletProvider.balanceTx / MidnightProvider.submitTx are single-method
// interfaces; WalletFacade exposes a more granular multi-step pipeline
// (balance -> sign -> prove/finalize -> submit). The adapter class below
// chains WalletFacade's real methods (balanceUnboundTransaction ->
// signRecipe -> finalizeRecipe for balanceTx; submitTransaction for
// submitTx) to satisfy the single-method interfaces midnight-js-contracts
// actually requires.
//
// HONEST SCOPE NOTE: this has NOT been exercised against a live network —
// Midnight transaction submission always needs a real proof-server
// and hosted ZK artifacts, both still unprovisioned as of this
// writing. This is code-complete and verified against real SDK source, the
// same "code-complete, blocked on infra" status the wallet bridge already carries — not
// a claim of live-tested correctness.
// ============================================================================

import WebSocket from 'ws';

const globalWithWebSocket = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
globalWithWebSocket.WebSocket = globalWithWebSocket.WebSocket ?? WebSocket;

import * as ledger from '@midnight-ntwrk/ledger-v8';
// FinalizedTransaction/CoinPublicKey/EncPublicKey are declared but not
// re-exported from midnight-js-types' own top-level index — import from
// their real source instead (the same module wallet-provider.d.ts itself
// imports them from).
import type { CoinPublicKey, EncPublicKey, FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { type DefaultConfiguration, WalletEntrySchema, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

export type MidnightNetwork = 'undeployed' | 'preview' | 'preprod' | 'mainnet';

export interface ServerWalletNetworkConfig {
  network: MidnightNetwork;
  /** wss://... (or ws://localhost:9944 for a local devnet) */
  relayUrl: string;
  /** http://... — the operated proof-server this launch's platform config points at. */
  provingServerUrl: string;
  indexerHttpUrl: string;
  indexerWsUrl: string;
}

/**
 * Real per-network endpoint defaults, verified against
 * midnight-wallet:managing-test-wallets' network-config.md. `mainnet`'s
 * real hostnames are not yet independently confirmed by this codebase (no
 * mainnet deployment exists yet) — callers targeting mainnet should
 * override relayUrl/indexerHttpUrl/indexerWsUrl explicitly rather than
 * trust a guessed hostname.
 */
export function defaultNetworkConfig(network: MidnightNetwork, provingServerUrl: string): ServerWalletNetworkConfig {
  switch (network) {
    case 'undeployed':
      return {
        network,
        relayUrl: 'ws://localhost:9944',
        provingServerUrl,
        indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
        indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
      };
    case 'preprod':
      return {
        network,
        relayUrl: 'wss://rpc.preprod.midnight.network',
        provingServerUrl,
        indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v3/graphql',
        indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
      };
    case 'preview':
      return {
        network,
        relayUrl: 'wss://rpc.preview.midnight.network',
        provingServerUrl,
        indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v3/graphql',
        indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
      };
    case 'mainnet':
      throw new Error(
        'No confirmed mainnet Midnight endpoint hostnames exist in this codebase yet — pass an explicit ServerWalletNetworkConfig rather than relying on this default.',
      );
  }
}

/**
 * WalletProvider + MidnightProvider adapter wrapping a real WalletFacade.
 * Verified against midnight-wallet:wallet-sdk's transactions.md and the
 * skill's own runnable transfer-flow.ts example — same
 * balanceUnboundTransaction -> signRecipe -> finalizeRecipe -> submitTransaction
 * chain that example uses for a real unshielded (signed) transfer.
 * updateAllowlistRoot's underlying transaction is unshielded (a plain
 * governor-authorized ledger call, not a private coin transfer), so the
 * signRecipe step is required here, same as that example's NIGHT transfer.
 */
class ServerWalletProvider implements WalletProvider, MidnightProvider {
  constructor(
    private readonly wallet: WalletFacade,
    private readonly shieldedSecretKeys: ledger.ZswapSecretKeys,
    private readonly dustSecretKey: ledger.DustSecretKey,
    private readonly unshieldedKeystore: ReturnType<typeof createKeystore>,
    // CoinPublicKey/EncPublicKey (@midnight-ntwrk/midnight-js-types) are
    // plain hex strings — real coin/encryption key TYPES here
    // (ShieldedCoinPublicKey/ShieldedEncryptionPublicKey, from
    // @midnight-ntwrk/wallet-sdk-address-format) are converted via their
    // own real .toHexString() before being stored.
    private readonly coinPublicKey: CoinPublicKey,
    private readonly encryptionPublicKey: EncPublicKey,
  ) {}

  getCoinPublicKey(): CoinPublicKey {
    return this.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.encryptionPublicKey;
  }

  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      {
        shieldedSecretKeys: this.shieldedSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      // WalletFacade's own options require a concrete ttl — default to a
      // generous 1-hour window when the caller (WalletProvider.balanceTx's
      // own ttl parameter is optional) didn't supply one.
      { ttl: ttl ?? new Date(Date.now() + 3600_000) },
    );
    const signed = await this.wallet.signRecipe(recipe, (payload: Uint8Array) =>
      this.unshieldedKeystore.signData(payload),
    );
    return (await this.wallet.finalizeRecipe(signed)) as FinalizedTransaction;
  }

  async submitTx(tx: FinalizedTransaction): Promise<string> {
    return await this.wallet.submitTransaction(tx);
  }
}

export interface ServerWallet {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  /** Real WalletFacade instance — kept for callers that need waitForSyncedState()/state() directly. */
  facade: WalletFacade;
  /** Must be called when done — stops the facade's background sync/subscriptions. */
  shutdown(): Promise<void>;
}

/**
 * Builds a real, synced, server-side wallet + the two ContractProviders
 * fields a Node CLI needs to sign and submit a governor-authorized circuit
 * call, from a raw 32-byte seed.
 *
 * This is the wallet that PAYS DUST fees for the transaction — a SEPARATE
 * concern from the governor's Compact WITNESS secret (getGovernorSecret(),
 * checked in-circuit against the contract's pinned governorKey). Either the
 * same 32 bytes or two entirely different secrets may be used for the two
 * roles; nothing on-chain requires them to match. See publish-allowlist-
 * root.ts's own header for how this project's CLI wires the two together.
 */
export async function buildServerWallet(seed: Uint8Array, config: ServerWalletNetworkConfig): Promise<ServerWallet> {
  const seedBuffer = Buffer.from(seed);

  const hdResult = HDWallet.fromSeed(seedBuffer);
  if (hdResult.type !== 'seedOk') {
    throw new Error(`buildServerWallet: invalid seed (${JSON.stringify(hdResult)})`);
  }

  const derivationResult = hdResult.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);
  hdResult.hdWallet.clear();
  if (derivationResult.type !== 'keysDerived') {
    throw new Error(`buildServerWallet: key derivation failed (${JSON.stringify(derivationResult)})`);
  }

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], config.network);

  const walletConfiguration: DefaultConfiguration = {
    networkId: config.network,
    // Matches managing-test-wallets' documented rationale: only the
    // zero-fee-rate local devnet needs a nonzero overhead to avoid a
    // NotNormalized (117) rejection; preprod/preview/mainnet have a real
    // fee rate and must NOT get an artificial overhead added.
    costParameters:
      config.network === 'undeployed'
        ? { feeBlocksMargin: 5, additionalFeeOverhead: 1_000_000n }
        : { feeBlocksMargin: 5 },
    relayURL: new URL(config.relayUrl),
    provingServerUrl: new URL(config.provingServerUrl),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };

  const facade = await WalletFacade.init({
    configuration: walletConfiguration,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);
  const state = await facade.waitForSyncedState();

  const provider = new ServerWalletProvider(
    facade,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    state.shielded.coinPublicKey.toHexString() as CoinPublicKey,
    state.shielded.encryptionPublicKey.toHexString() as EncPublicKey,
  );

  return {
    walletProvider: provider,
    midnightProvider: provider,
    facade,
    shutdown: () => facade.stop(),
  };
}
