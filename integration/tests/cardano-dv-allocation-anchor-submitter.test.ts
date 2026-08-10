// Tests for cardano-dv-allocation-anchor-submitter.ts's
// CardanoDvAllocationAnchorSubmitter — anchors the governor-computed
// dv_allocation_root onto bonding_curve_tier_b.ak, gated on curve_state ==
// Inactive. Same importOriginal partial-mock strategy as the other Lucid
// submitter tests (only Lucid() and Data.from/to swapped) — CML.PrivateKey
// (the extended-key -> bech32 conversion) stays real, so a genuinely valid
// 64-byte extended Ed25519 private key is used, not an opaque placeholder.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Data: {
      ...actual.Data,
      from: vi.fn((d: unknown) => d),
      to: vi.fn((d: unknown) => d),
    },
  };
});

import { CML, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { CardanoDvAllocationAnchorSubmitter, fromHex } from '../cardano-dv-allocation-anchor-submitter.js';
import { BONDING_CURVE_TIER_B_REDEEMER } from '../redeemer-indices.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// A genuinely valid 64-byte extended Ed25519 private key (kL||kR), generated
// once via the real CML.PrivateKey.generate_ed25519extended() and pinned
// here so this test doesn't depend on non-determinism.
const REAL_EXTENDED_KEY_HEX = CML.PrivateKey.generate_ed25519extended().to_raw_bytes
  ? toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes())
  : '';

// The curve records which key its governor is, and the submitter refuses a
// signer that is not it — so these have to be REAL addresses whose payment
// credential can actually be read, not placeholder strings. A launch that
// names a governor nothing can parse is not a launch that could exist.
const GOVERNOR_KEY_HASH = 'ab'.repeat(28);
const GOVERNOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: GOVERNOR_KEY_HASH });
const STRANGER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: 'cd'.repeat(28) });

const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-dv-anchor-1'));
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX);
// A real UTXO always has a reference, and settlement outputs are tagged with
// it — a fixture without one describes a UTXO the chain cannot produce, and
// hides every code path that reads it.
const withThreadNft = <T extends { assets?: Record<string, bigint> }>(list: T[]): T[] =>
  list.map((u, i) => ({
    txHash: 'fe'.repeat(32),
    outputIndex: i,
    ...u,
    assets: { [THREAD_UNIT]: 1n, ...(u.assets ?? {}) },
  }));

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('dv-anchor-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls };
}

function baseDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    curve_state: 'Inactive',
    governor_pub_key_hash: GOVERNOR_KEY_HASH,
    dv_allocation_root: toHex(new Uint8Array(32)),
    dv_settled: false,
    ...overrides,
  };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return {
    submitter: new CardanoDvAllocationAnchorSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      compiledScriptCbor: '590000',
      launchIdHex: LAUNCH_ID_HEX,
      threadNftPolicyId: THREAD_POLICY,
    }),
    fakeLucid,
  };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('extended-key conversion (via CML, kept real)', () => {
  it('accepts a real 64-byte extended key and rejects a wrong-length one', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await expect(submitter.anchorDvAllocationRoot('aabb', GOVERNOR_ADDRESS, toHex(new Uint8Array(32)))).rejects.toThrow(
      /Expected a 64-byte extended private key/,
    );
  });
});

describe('CardanoDvAllocationAnchorSubmitter.readCurveDatum', () => {
  it('returns the decoded datum for the configured launchIdHex', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      { datum: baseDatum({ launch_id: 'other-launch' }), assets: {} },
      {
        datum: baseDatum({
          dv_allocation_root: toHex(new Uint8Array(32).fill(7)),
        }),
        assets: {},
      },
    ]);

    const result = await submitter.readCurveDatum();
    expect(result.dv_allocation_root).toBe(toHex(new Uint8Array(32).fill(7)));
  });

  it('throws when no UTXO matches the configured launchIdHex', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ launch_id: 'other-launch' }), assets: {} }]);

    await expect(submitter.readCurveDatum()).rejects.toThrow(/carries launch/);
  });
});

describe('CardanoDvAllocationAnchorSubmitter.anchorDvAllocationRoot', () => {
  it('rejects anchoring once the curve is no longer Inactive', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);

    await expect(
      submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, toHex(new Uint8Array(32))),
    ).rejects.toThrow(/Curve is not Inactive/);
  });

  // Found on Preprod. The curve checks the governor recorded in its own datum,
  // so signing with the platform's governor key for a launch that names some
  // other key produces a script failure carrying no detail at all — the remote
  // evaluator reports that the spend failed and names neither key. Refusing it
  // here turns half an hour of guessing into one sentence.
  it('refuses a signer the launch does not name, and names both keys', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await expect(
      submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, STRANGER_ADDRESS, toHex(new Uint8Array(32))),
    ).rejects.toThrow(new RegExp(`${GOVERNOR_KEY_HASH}[\\s\\S]*${'cd'.repeat(28)}`));
  });

  it('is freely re-callable (no once-only gate) while curve_state stays Inactive', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Inactive' }), assets: {} }]);

    const rootA = toHex(new Uint8Array(32).fill(1));
    const rootB = toHex(new Uint8Array(32).fill(2));
    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, rootA);
    const firstPayload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(firstPayload.value.dv_allocation_root).toBe(rootA);

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, rootB);
    const secondPayload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(secondPayload.value.dv_allocation_root).toBe(rootB);
  });

  it('sets dv_settled to true and preserves other datum fields (curve_state, launch_id)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ dv_settled: false }), assets: {} }]);

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, toHex(new Uint8Array(32).fill(9)));

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.dv_settled).toBe(true);
    expect(payload.value.curve_state).toBe('Inactive');
    expect(payload.value.launch_id).toBe(LAUNCH_ID_HEX);
  });

  it("re-locks the curve UTXO's own assets unchanged (no ADA/token movement here)", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    // The thread NFT is part of what the UTXO holds, so re-locking its own
    // assets unchanged means re-locking that too.
    const existingAssets = { lovelace: 4_000_000n, [THREAD_UNIT]: 1n };
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: existingAssets }]);

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, toHex(new Uint8Array(32)));

    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    expect(assetsArg).toEqual(existingAssets);
  });

  it('selects the wallet from the governor address + the UTXOs it looked up at that address (real base-address coin selection)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, fakeLucid } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, toHex(new Uint8Array(32)));

    expect(fakeLucid.utxosAt).toHaveBeenCalledWith(GOVERNOR_ADDRESS);
    const governorUtxos = await fakeLucid.utxosAt.mock.results[fakeLucid.utxosAt.mock.results.length - 1].value;
    expect(fakeLucid.selectWallet.fromAddress).toHaveBeenCalledWith(GOVERNOR_ADDRESS, governorUtxos);
  });

  it('adds the governor address as the required signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, toHex(new Uint8Array(32)));
    expect(calls.addSigner).toEqual([GOVERNOR_ADDRESS]);
  });

  // This assertion used to carry the literal 12, and it passed — because the
  // submitter also carried 12, and both had been right when written. A
  // variant added ahead of AnchorDvAllocationRoot moved it to 11 and neither
  // noticed. So the expected index now comes from the same named table
  // redeemer-indices.test.ts pins against the compiled blueprint: a test and
  // an implementation cannot agree with each other into being wrong.
  it('sends AnchorDvAllocationRoot, at whatever index the validator gives it', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const root = toHex(new Uint8Array(32).fill(42));

    await submitter.anchorDvAllocationRoot(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDRESS, root);
    const redeemer = calls.collectFrom![1] as { index: number; fields: unknown[] };
    expect(redeemer.index).toBe(BONDING_CURVE_TIER_B_REDEEMER.AnchorDvAllocationRoot);
    expect(redeemer.fields).toEqual([root]);
  });
});

describe('fromHex (pure helper)', () => {
  it('decodes a hex string to bytes', () => {
    expect(Array.from(fromHex('00abff'))).toEqual([0x00, 0xab, 0xff]);
  });
});
