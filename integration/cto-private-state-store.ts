// ============================================================================
// Noctis Protocol — CTO Governance: witness-secret persistence
// ============================================================================
// Same design and reasoning as private-state-store.ts (reworked
// 2026-07-15) — a Midnight secret key derived deterministically from a
// wallet signature, not randomly generated and only stored, so clearing
// browser data never permanently loses a voter's identity (reconnecting the
// SAME Cardano wallet and re-signing the same fixed message always
// reproduces the identical secret). Deliberately a SEPARATE store from
// DarkVeil's, not a shared one, for two real reasons:
//   1. A CTO voter never needs to have participated in DarkVeil at all —
//      voting eligibility is "held tokens at snapshot time," unrelated to
//      DarkVeil registration. Reusing DarkVeil's own MASTER_SIGNATURE_DOMAIN
//      would show a "DarkVeil" message in the wallet's sign-data prompt to a
//      user who has no idea what that means.
//   2. cto_governance.compact's OWN deriveUserPublicKey circuit already
//      domain-separates on-chain (pad(32, "noctis:cto:user:pk:v1") —
//      DOMAINS.CTO_USER in contracts/midnight/witnesses.ts), so reusing
//      DarkVeil's raw secret here would still be cryptographically safe in
//      principle (per witnesses.ts's own "domain separation across PSMs"
//      reasoning) — but deriving a genuinely separate raw secret under its
//      own off-chain domain matches this codebase's established double
//      domain-separation convention (private-state-store.ts's own SK_DOMAIN
//      is a second layer on top of the on-chain circuit's domain, not a
//      substitute for it) rather than leaning on the on-chain layer alone.
//
// HONEST SCOPE NOTE (2026-07-19): this covers the CLIENT-SIDE half only —
// deriving and persisting a voter's real getUserSecret() witness so
// createProposal/castVote can be called for real. The GOVERNOR-SIDE half
// (verifying a submitted signature server-side and recording the resulting
// (cardanoAddress -> derived CTO voter pubkey) binding so the balance-
// snapshot builder, item #11, can look it up) is deliberately NOT built
// here — it needs real COSE_Sign1 signature verification (CML, already a
// transitive dependency via @lucid-evolution/lucid per the enterprise-
// address work, but not yet wired for verification anywhere in this
// codebase) and a real intake endpoint, both substantial enough to deserve
// their own focused pass rather than being rushed alongside this file.
// Tracked as a follow-up, not silently dropped.
// ============================================================================

import {
  type LevelPrivateStateProviderConfig,
  levelPrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {
  asContractAddress,
  type ExportPrivateStatesOptions,
  type ImportPrivateStatesOptions,
  type ImportPrivateStatesResult,
  type PrivateStateExport,
  type PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import type { UserSecretKey } from '../contracts/midnight/witnesses.js';
import { bytesToHex, deriveFromSignature, hexToBytes } from './private-state-store.js';

// ============================================================================
// DETERMINISTIC DERIVATION
// ============================================================================

/**
 * The one fixed message a voter's wallet signs, once, to unlock CTO voting
 * identity recovery. Deliberately its own domain, separate from DarkVeil's
 * MASTER_SIGNATURE_DOMAIN — see file header.
 */
export const CTO_MASTER_SIGNATURE_DOMAIN = 'noctis:cto:master:v1';

// Exported (2026-07-19) so cto-voter-registration.ts's server-side
// re-derivation can import this exact constant rather than duplicating the
// literal — the server must derive the IDENTICAL secret from a verified
// signature that this file's own client-side getOrCreateIdentity() would,
// so any drift between two copies of this string would be a real bug.
export const CTO_SK_DOMAIN = 'noctis:cto:derive:sk:v1';

// ============================================================================
// TYPES
// ============================================================================

export interface CtoIdentity {
  userSecretKey: UserSecretKey;
}

interface StoredCtoIdentity {
  secretKeyHex: string;
}

const CTO_IDENTITY_PRIVATE_STATE_ID = 'noctis:cto:identity:v1';

// Distinct sentinel from private-state-store.ts's own IDENTITY_SENTINEL_HEX
// ('...fd') — these are local storage-scoping keys only, not real on-chain
// addresses, but must not collide with any other scope the same account's
// underlying levelPrivateStateProvider instance might use.
const CTO_IDENTITY_SENTINEL_HEX = `${'00'.repeat(31)}fe`;
const CTO_IDENTITY_SENTINEL_ADDRESS = asContractAddress(CTO_IDENTITY_SENTINEL_HEX);

export interface CtoPrivateStore {
  /**
   * Get this account's CTO voting identity. Reads the local cache first; on
   * a cache miss (first use, or the cache was wiped), asks
   * getMasterSignature() for a wallet signature and re-derives the
   * identical identity deterministically — see file header.
   */
  getOrCreateIdentity(): Promise<CtoIdentity>;
  /**
   * Real encrypted backup of just this identity scope (unlike DarkVeil's
   * multi-scope bundle — CTO identity has no per-launch sub-scopes, only
   * one value to ever export).
   */
  exportBackup(backupPassword: string): Promise<PrivateStateExport>;
  /** Restore from a real exportBackup() output. */
  importBackup(bundle: PrivateStateExport, backupPassword: string): Promise<ImportPrivateStatesResult>;
  /** The underlying provider, for wiring into a full ContractProviders. */
  readonly provider: PrivateStateProvider;
}

export interface CreateCtoPrivateStoreConfig {
  /** Connected wallet's address — scopes storage per-account (SHA-256 hashed internally by the real provider). */
  accountId: string;
  /** Real password meeting the SDK's strength policy (validatePassword). Can share the same underlying wallet signature as getMasterSignature below (a different domain-separated hash of it, mirroring widget/password-derivation.ts's own approach), so only one wallet prompt is needed for both. */
  passwordProvider: () => string | Promise<string>;
  /**
   * Returns the hex signature over CTO_MASTER_SIGNATURE_DOMAIN from the
   * connected wallet (e.g. via wallet-connection.ts's signCardanoData).
   * Only called on a genuine cache miss — a warm cache never prompts the
   * wallet at all.
   */
  getMasterSignature: () => Promise<string>;
  /** Passed through to levelPrivateStateProvider for test isolation. Omit in production. */
  levelFactory?: LevelPrivateStateProviderConfig['levelFactory'];
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

export function createCtoPrivateStore(config: CreateCtoPrivateStoreConfig): CtoPrivateStore {
  const provider = levelPrivateStateProvider<string, unknown>({
    privateStoragePasswordProvider: config.passwordProvider,
    accountId: config.accountId,
    ...(config.levelFactory ? { levelFactory: config.levelFactory } : {}),
  });

  // In-memory only (never persisted), same reasoning as
  // private-state-store.ts's own getMasterSignatureCached — caches the
  // in-flight PROMISE (not the resolved value) so concurrent cache misses
  // await one wallet prompt, not several; clears on rejection so a declined
  // prompt doesn't permanently stick the store.
  let signaturePromise: Promise<string> | null = null;
  function getMasterSignatureCached(): Promise<string> {
    if (signaturePromise === null) {
      signaturePromise = config.getMasterSignature().catch((err) => {
        signaturePromise = null;
        throw err;
      });
    }
    return signaturePromise;
  }

  async function readIdentityRecord(): Promise<StoredCtoIdentity | null> {
    provider.setContractAddress(CTO_IDENTITY_SENTINEL_ADDRESS);
    return (await provider.get(CTO_IDENTITY_PRIVATE_STATE_ID)) as StoredCtoIdentity | null;
  }

  async function getOrCreateIdentity(): Promise<CtoIdentity> {
    const existing = await readIdentityRecord();
    if (existing) {
      return { userSecretKey: { bytes: hexToBytes(existing.secretKeyHex) } };
    }

    const masterSig = await getMasterSignatureCached();
    const userSecretKey: UserSecretKey = {
      bytes: deriveFromSignature(CTO_SK_DOMAIN, masterSig),
    };

    const stored: StoredCtoIdentity = {
      secretKeyHex: bytesToHex(userSecretKey.bytes),
    };
    provider.setContractAddress(CTO_IDENTITY_SENTINEL_ADDRESS);
    await provider.set(CTO_IDENTITY_PRIVATE_STATE_ID, stored);
    return { userSecretKey };
  }

  async function exportBackup(backupPassword: string): Promise<PrivateStateExport> {
    validatePassword(backupPassword);
    const record = await readIdentityRecord();
    if (!record) {
      throw new Error('exportBackup: no identity exists yet — call getOrCreateIdentity first');
    }
    provider.setContractAddress(CTO_IDENTITY_SENTINEL_ADDRESS);
    return provider.exportPrivateStates({
      password: backupPassword,
    } satisfies ExportPrivateStatesOptions);
  }

  async function importBackup(bundle: PrivateStateExport, backupPassword: string): Promise<ImportPrivateStatesResult> {
    validatePassword(backupPassword);
    provider.setContractAddress(CTO_IDENTITY_SENTINEL_ADDRESS);
    return provider.importPrivateStates(bundle, {
      password: backupPassword,
      conflictStrategy: 'overwrite',
    } satisfies ImportPrivateStatesOptions);
  }

  return { getOrCreateIdentity, exportBackup, importBackup, provider };
}
