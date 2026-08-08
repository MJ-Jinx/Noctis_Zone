import { MemoryLevel } from 'memory-level';
import { describe, expect, it, vi } from 'vitest';
import { createCtoPrivateStore } from '../cto-private-state-store.js';

// Real password meeting the SDK's actual strength policy — not a mock, this
// is what gets fed to the real levelPrivateStateProvider/StorageEncryption
// underneath. Same real-policy discipline as private-state-store.test.ts.
const REAL_PASSWORD = 'Tr0ub4dor&Zebra!9k';
const OTHER_REAL_PASSWORD = 'Qx7$mVenice42Lagoon';

// Fake wallet signatures, standing in for what a real CIP-8 signCardanoData
// call would return for a given wallet + CTO_MASTER_SIGNATURE_DOMAIN. Real
// Ed25519 signing is deterministic (same key + same message -> same
// signature always) — the whole property this store's recovery depends on.
const WALLET_A_SIGNATURE = 'aa'.repeat(64);
const WALLET_B_SIGNATURE = 'bb'.repeat(64);

function freshMemoryLevelFactory() {
  // Memoized by dbName WITHIN one call to this function, matching
  // private-state-store.test.ts's own documented gotcha: an unmemoized
  // factory silently breaks read-after-write (each set()/get() hitting a
  // different empty MemoryLevel).
  const cache = new Map<string, MemoryLevel<string, string>>();
  return (dbName: string) => {
    let db = cache.get(dbName);
    if (!db) {
      db = new MemoryLevel<string, string>();
      cache.set(dbName, db);
    }
    return db;
  };
}

function makeStore(accountId: string, walletSignature: string, password = REAL_PASSWORD) {
  const getMasterSignature = vi.fn(async () => walletSignature);
  const store = createCtoPrivateStore({
    accountId,
    passwordProvider: () => password,
    getMasterSignature,
    levelFactory: freshMemoryLevelFactory(),
  });
  return { store, getMasterSignature };
}

describe('cto-private-state-store.ts — deterministic CTO voting identity derivation', () => {
  it('generates a fresh identity on first use, derived from the wallet signature', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const identity = await store.getOrCreateIdentity();
    expect(identity.userSecretKey.bytes).toBeInstanceOf(Uint8Array);
    expect(identity.userSecretKey.bytes.length).toBe(32);
  });

  it('returns the SAME identity on a second call, without re-prompting the wallet (cache hit)', async () => {
    const { store, getMasterSignature } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const first = await store.getOrCreateIdentity();
    const second = await store.getOrCreateIdentity();
    expect(second.userSecretKey.bytes).toEqual(first.userSecretKey.bytes);
    expect(getMasterSignature).toHaveBeenCalledTimes(1);
  });

  it('recovers the IDENTICAL identity in a fresh store (simulated cleared browser data) given the same wallet signature', async () => {
    const original = await (async () => {
      const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
      return store.getOrCreateIdentity();
    })();

    const { store: recoveredStore } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const recovered = await recoveredStore.getOrCreateIdentity();

    expect(recovered.userSecretKey.bytes).toEqual(original.userSecretKey.bytes);
  });

  it('different wallets (different signatures) derive different identities', async () => {
    const { store: storeA } = makeStore('wallet-addr-A', WALLET_A_SIGNATURE);
    const { store: storeB } = makeStore('wallet-addr-B', WALLET_B_SIGNATURE);
    const idA = await storeA.getOrCreateIdentity();
    const idB = await storeB.getOrCreateIdentity();
    expect(idA.userSecretKey.bytes).not.toEqual(idB.userSecretKey.bytes);
  });

  it('derives a DIFFERENT secret than DarkVeil would for the same wallet signature (separate off-chain domain)', async () => {
    // Cross-check against private-state-store.ts's own derivation directly,
    // proving the two stores never accidentally collide even when driven by
    // the exact same underlying wallet signature.
    const { deriveFromSignature } = await import('../private-state-store.js');
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const ctoIdentity = await store.getOrCreateIdentity();
    const darkVeilSk = deriveFromSignature('noctis:darkveil:derive:sk:v1', WALLET_A_SIGNATURE);
    expect(ctoIdentity.userSecretKey.bytes).not.toEqual(darkVeilSk);
  });
});

describe('cto-private-state-store.ts — optional secondary backup flow (export/import)', () => {
  it('round-trips an identity through exportBackup/importBackup into a fresh store', async () => {
    const { store: storeA } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const original = await storeA.getOrCreateIdentity();
    const backup = await storeA.exportBackup(OTHER_REAL_PASSWORD);
    expect(backup.format).toBe('midnight-private-state-export');

    // Fresh store, fresh backing memory-level, DIFFERENT wallet signature —
    // proves the backup restores the original identity even when the
    // deterministic re-derivation path isn't available (e.g. the user no
    // longer has that wallet).
    const { store: storeB } = makeStore('wallet-addr-1', WALLET_B_SIGNATURE);
    await storeB.importBackup(backup, OTHER_REAL_PASSWORD);
    const restored = await storeB.getOrCreateIdentity();

    expect(restored.userSecretKey.bytes).toEqual(original.userSecretKey.bytes);
  });

  it('rejects a backup password that fails the real SDK strength policy', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await store.getOrCreateIdentity();
    await expect(store.exportBackup('short')).rejects.toThrow();
  });

  it('importing with the WRONG password fails rather than silently returning garbage', async () => {
    const { store: storeA } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await storeA.getOrCreateIdentity();
    const backup = await storeA.exportBackup(OTHER_REAL_PASSWORD);

    const { store: storeB } = makeStore('wallet-addr-1', WALLET_B_SIGNATURE);
    await expect(storeB.importBackup(backup, 'Wr0ngPassw0rd!!Nope')).rejects.toThrow();
  });

  it('exportBackup fails cleanly when no identity has been created yet', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await expect(store.exportBackup(OTHER_REAL_PASSWORD)).rejects.toThrow(/no identity exists/i);
  });
});
