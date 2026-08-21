// ============================================================================
// Noctis Zone — ContractProviders Assembly
// ============================================================================
// Nothing in this codebase builds a real MidnightProviders/ContractProviders
// object today -- integration/midnight-client.ts's every deployContract/
// findDeployedContract call site (confirmed by grep) only ever CONSUMES a
// `providers: ContractProviders` argument the caller already has; no code
// path constructs one. This module is that missing piece, scoped honestly:
//
//   - privateStateProvider: REAL, fully built and tested here, via
//     private-state-store.ts's DarkVeilPrivateStore (backed by the real
//     @midnight-ntwrk/midnight-js-level-private-state-provider@4.1.1).
//   - publicDataProvider / zkConfigProvider / proofProvider / walletProvider
//     / midnightProvider: accepted as typed pass-through parameters, NOT
//     built here. Each needs real, live network infrastructure (a Midnight
//     indexer, a proof server, a connected wallet's transaction-balancing
//     API) that this project's own investigation already found doesn't
//     have a working local devnet to develop and test against (documented,
//     reproducible midnight-node crash, no ETA). Building fake/mock
//     versions of these here would misrepresent what's actually been
//     verified working -- same "flag what's not tested, don't paper over
//     it" discipline as the Cardano anchor submitter.
//
// Callers assemble the other four/five providers from whatever real SDK
// wiring exists for them (e.g. a real midnight-js indexer client, a real
// wallet-connector-backed WalletProvider) and pass them in here alongside
// a DarkVeilPrivateStore -- this function's only real job is wiring the
// private-state piece in correctly, since that's the part this session
// actually built and verified.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import type {
  LoggerProvider,
  MidnightProvider,
  ProofProvider,
  PublicDataProvider,
  WalletProvider,
  ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type { DarkVeilPrivateStore } from './private-state-store.js';

export interface NoctisContractProvidersConfig {
  privateStore: DarkVeilPrivateStore;
  publicDataProvider: PublicDataProvider;
  zkConfigProvider: ZKConfigProvider<string>;
  proofProvider: ProofProvider;
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  loggerProvider?: LoggerProvider;
}

/**
 * Assembles a real ContractProviders for use with midnight-client.ts's
 * deploy/connect methods. The privateStateProvider field is real and fully
 * wired (see private-state-store.ts); every other field is exactly what
 * the caller supplied -- this function does not fabricate or stub any of
 * them.
 */
export function createNoctisContractProviders(config: NoctisContractProvidersConfig): ContractProviders {
  return {
    privateStateProvider: config.privateStore.provider,
    publicDataProvider: config.publicDataProvider,
    zkConfigProvider: config.zkConfigProvider,
    proofProvider: config.proofProvider,
    walletProvider: config.walletProvider,
    midnightProvider: config.midnightProvider,
    ...(config.loggerProvider ? { loggerProvider: config.loggerProvider } : {}),
  };
}
