// ============================================================================
// Noctis Protocol — DarkVeil widget: real Midnight wallet → ContractProviders bridge
// ============================================================================
// Closes a real gap: no code anywhere in this codebase built a
// working WalletProvider/MidnightProvider from a connected Midnight wallet,
// so registerOnChain/submitBuyCommit/revealBuyCommit could never actually
// submit a transaction. Verified against a real reference before writing
// this — Midnight's own official `example-zkloan` tutorial repo
// (`zkloan-credit-scorer-ui/src/contexts/ZKLoanContext.tsx`, not linked from
// the docs pages, only found by browsing the repo tree) has a working
// implementation targeting the EXACT SAME package versions this repo already
// pins (`@midnight-ntwrk/midnight-js-contracts@4.1.1`,
// `@midnight-ntwrk/dapp-connector-api@4.0.1`, `compact-runtime@^0.16.0`) —
// confirmed by reading that repo's real package.json before adapting
// anything, not assumed compatible from the version number alone.
//
// Three of the six ContractProviders fields are genuinely derivable from
// JUST a connected wallet, with no separate infrastructure decision needed:
//   - walletProvider  (balanceTx, via the wallet's own balanceUnsealedTransaction)
//   - midnightProvider (submitTx, via the wallet's own submitTransaction)
//   - publicDataProvider (indexer queries, via the wallet's OWN reported
//     indexerUri/indexerWsUri from getConfiguration() — the wallet already
//     knows which indexer its user prefers; Noctis doesn't need to run or
//     configure one itself)
//
// The other three (privateStateProvider, zkConfigProvider, proofProvider)
// are NOT built here:
//   - privateStateProvider already has a real answer — private-state-store.ts
//     — the caller supplies that separately.
//   - zkConfigProvider/proofProvider genuinely need a real, separate
//     deployment decision this module cannot make on its own: where are
//     Noctis's compiled contracts' ZK artifacts (prover/verifier keys, ZKIR)
//     actually hosted for a browser to fetch? `Configuration.proverServerUri`
//     is explicitly `@deprecated` in the real installed dapp-connector-api
//     types (`Use getProvingProvider instead` — a real finding, not in the
//     example tutorial, which still uses the deprecated field) — the more
//     correct path is wallet-delegated proving via
//     `connectedAPI.getProvingProvider(keyMaterialProvider)`, but that still
//     needs a real `KeyMaterialProvider` reading real hosted ZK artifact
//     files, which is the same unresolved hosting question either way. Left
//     as a clearly flagged, separate gap rather than guessed at.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
  Transaction,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type {
  MidnightProvider,
  PublicDataProvider,
  UnboundTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type { MidnightConnectedAPI } from '../wallet-connection.js';

// Transaction.deserialize's first 3 args are TYPE MARKERS, not class
// references — confirmed against the real installed ledger-v8.d.ts: `instance`
// is a plain (non-static) string-literal-typed property on each class
// (`readonly instance: 'signature'` etc.), used only at the type level via
// `S['instance']`. The runtime value expected is the literal string itself,
// NOT `SignatureEnabled.instance` (undefined — no static member exists) and
// NOT `SignatureEnabled.prototype.instance` (also undefined on a wasm-bindgen
// class with no prototype-level field).
const SIGNATURE_ENABLED_MARKER = 'signature' as const;
const PROOF_MARKER = 'proof' as const;
const BINDING_MARKER = 'binding' as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface MidnightWalletBridgeParams {
  connection: MidnightConnectedAPI;
  /** From MidnightWalletConnection's own summary fields, already fetched at connect time — avoids a second getShieldedAddresses() round-trip. */
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  /** Optional — updates the UI while a wallet-driven balance/submit call is in flight. */
  onFlowMessage?: (message: string | undefined) => void;
}

export interface MidnightWalletBridge {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  publicDataProvider: PublicDataProvider;
  /** The wallet's own reported indexer/prover/node config — useful for callers that DO want to wire zkConfigProvider/proofProvider themselves (e.g. via connection.api.getProvingProvider). */
  indexerUri: string;
  indexerWsUri: string;
}

/**
 * Builds the 3 wallet-derivable ContractProviders fields from an already-
 * connected Midnight wallet. Combine with a real privateStateProvider
 * (private-state-store.ts) and a real zkConfigProvider/proofProvider (still
 * a genuinely separate hosting decision, see file header) to get a full
 * ContractProviders for contract-providers.ts's createNoctisContractProviders.
 */
export async function buildMidnightWalletBridge(params: MidnightWalletBridgeParams): Promise<MidnightWalletBridge> {
  const { connection, shieldedCoinPublicKey, shieldedEncryptionPublicKey, onFlowMessage } = params;

  const config = await connection.getConfiguration();

  const walletProvider: WalletProvider = {
    getCoinPublicKey(): CoinPublicKey {
      return shieldedCoinPublicKey as CoinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return shieldedEncryptionPublicKey as EncPublicKey;
    },
    async balanceTx(tx: UnboundTransaction, _ttl?: Date): Promise<FinalizedTransaction> {
      onFlowMessage?.('Signing the transaction with your Midnight wallet...');
      try {
        const serializedStr = bytesToHex(tx.serialize());

        // Real Lace-wallet quirk, confirmed against example-zkloan's own
        // code comment: the extension's messaging layer appends {sender} as
        // a THIRD positional argument, so an explicit (even empty) options
        // object must be passed second or {sender} lands in the wrong slot.
        // `balanceUnsealedTransaction` is a real declared method on the
        // installed dapp-connector-api@4.0.1 ConnectedAPI type — no cast needed.
        const result = await connection.balanceUnsealedTransaction(serializedStr, {});

        const resultBytes = hexToBytes(result.tx);
        return Transaction.deserialize(
          SIGNATURE_ENABLED_MARKER,
          PROOF_MARKER,
          BINDING_MARKER,
          resultBytes,
        ) as FinalizedTransaction;
      } finally {
        onFlowMessage?.(undefined);
      }
    },
  };

  const midnightProvider: MidnightProvider = {
    async submitTx(tx: FinalizedTransaction) {
      onFlowMessage?.('Submitting transaction...');
      try {
        const serializedStr = bytesToHex(tx.serialize());
        await connection.submitTransaction(serializedStr);
        const [txId] = tx.identifiers();
        return txId;
      } finally {
        onFlowMessage?.(undefined);
      }
    },
  };

  const publicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);

  return {
    walletProvider,
    midnightProvider,
    publicDataProvider,
    indexerUri: config.indexerUri,
    indexerWsUri: config.indexerWsUri,
  };
}
