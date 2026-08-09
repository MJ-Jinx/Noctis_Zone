// Covers the registry's key: a binding is identified by (cardanoAddress,
// launchIdHex), never by address alone. That distinction is the whole reason
// launch-scoped voter identities survive being stored — one wallet holds a
// different identity per launch, and a registry keyed on address alone would
// let the second registration destroy the first.
import { describe, expect, it } from 'vitest';
import { createInMemoryCtoVoterRegistry } from '../cto-voter-registry.js';

const LAUNCH_A = '09'.repeat(32);
const LAUNCH_B = '0a'.repeat(32);
const WALLET = 'addr_test1_wallet';

function binding(launchIdHex: string, ctoVoterPubKeyHex: string, cardanoAddress = WALLET) {
  return { cardanoAddress, launchIdHex, ctoVoterPubKeyHex, registeredAt: 1_700_000_000 };
}

describe('cto-voter-registry.ts — in-memory registry', () => {
  it('records a binding and looks it back up under its own launch', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    await registry.record(binding(LAUNCH_A, 'aa'.repeat(32)));

    const found = await registry.lookup(WALLET, LAUNCH_A);
    expect(found?.ctoVoterPubKeyHex).toBe('aa'.repeat(32));
  });

  it('does not answer a lookup for a launch the wallet never registered with', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    await registry.record(binding(LAUNCH_A, 'aa'.repeat(32)));

    expect(await registry.lookup(WALLET, LAUNCH_B)).toBeNull();
  });

  it('keeps one wallet’s two launch identities side by side', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    await registry.record(binding(LAUNCH_A, 'aa'.repeat(32)));
    await registry.record(binding(LAUNCH_B, 'bb'.repeat(32)));

    // The second registration must not have displaced the first — if it had,
    // registering for a new launch would silently revoke a voter's standing
    // in every earlier one.
    expect((await registry.lookup(WALLET, LAUNCH_A))?.ctoVoterPubKeyHex).toBe('aa'.repeat(32));
    expect((await registry.lookup(WALLET, LAUNCH_B))?.ctoVoterPubKeyHex).toBe('bb'.repeat(32));
  });

  it('overwrites a re-registration for the SAME launch', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    await registry.record(binding(LAUNCH_A, 'aa'.repeat(32)));
    await registry.record(binding(LAUNCH_A, 'cc'.repeat(32)));

    expect((await registry.lookup(WALLET, LAUNCH_A))?.ctoVoterPubKeyHex).toBe('cc'.repeat(32));
    expect(await registry.all(LAUNCH_A)).toHaveLength(1);
  });

  it('enumerates only the bindings belonging to the launch asked for', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    await registry.record(binding(LAUNCH_A, 'aa'.repeat(32), 'addr_test1_one'));
    await registry.record(binding(LAUNCH_A, 'bb'.repeat(32), 'addr_test1_two'));
    await registry.record(binding(LAUNCH_B, 'cc'.repeat(32), 'addr_test1_one'));

    // A snapshot is built for a single ballot: another launch's identities
    // are not valid leaves in it.
    const forA = await registry.all(LAUNCH_A);
    expect(forA.map((b) => b.cardanoAddress).sort()).toEqual(['addr_test1_one', 'addr_test1_two']);
    expect(forA.every((b) => b.launchIdHex === LAUNCH_A)).toBe(true);

    expect(await registry.all(LAUNCH_B)).toHaveLength(1);
  });
});
