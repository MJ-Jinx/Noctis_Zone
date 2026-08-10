// Tests for staking-submitter.ts's StakingSubmitter — the shared
// Tier A/B staking_pool.ak validator (Pool + Position datum shapes sharing
// one address). Covers all 6 real actions: Stake (plain deposit, no
// redeemer), Unstake (ownership check via staker_vkh), ClaimRewards
// (deliberately permissionless on-chain — verified here as "no addSigner
// call at all" — Merkle-proof-driven payout with in-place vs. append
// per-root bitmap nullifier), TopUpPool (creator-only), and PublishRewardRoot
// (governor-only). Same importOriginal partial-mock Lucid strategy as the
// other submitter tests.

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

import { CML, type Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import type { StakingPosition } from '../staking-submitter.js';
import { extendedHexToBech32PrivateKey, keyHashFromAddress, StakingSubmitter } from '../staking-submitter.js';
import { settlementDatum, threadNftAssetName } from '../tier-a-schemas.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const REAL_EXTENDED_KEY_HEX = toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes());
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-staking-1'));
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_ASSET_NAME;
const CREATOR_KEY_HASH = fakeKeyHash(0x11);
const GOVERNOR_KEY_HASH = fakeKeyHash(0x22);
const THREAD_POLICY = 'cc'.repeat(28);

/** The pool's own thread NFT — the token findPoolUtxo authenticates on. */
const POOL_THREAD_NFT = THREAD_POLICY + threadNftAssetName('stakingPool', LAUNCH_ID_HEX);

function poolDatumFields(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    creator_pub_key_hash: CREATOR_KEY_HASH,
    governor_pub_key_hash: GOVERNOR_KEY_HASH,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    reward_root: toHex(new Uint8Array(32)),
    // Two bytes, so a fixture can address bits either side of a byte
    // boundary without needing its own map.
    claimed_bits: '0000',
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}
/**
 * A real pool UTXO carries its thread NFT — that is what distinguishes it from
 * anything else anyone pays to the shared staking address, and no pool has
 * existed without one. Merged UNDER the caller's assets so a test can still
 * override it, and `bare` describes a pool that genuinely lacks it.
 */
function poolUtxo(
  fields: Record<string, unknown> = {},
  assets: Record<string, bigint> = {},
  opts: { bare?: boolean } = {},
) {
  return {
    datum: { Pool: [poolDatumFields(fields)] },
    assets: opts.bare ? assets : { [POOL_THREAD_NFT]: 1n, ...assets },
  };
}
function positionUtxo(overrides: Record<string, unknown> = {}, assets: Record<string, bigint> = {}) {
  return {
    // A position is a real UTXO with a real reference, and its unstake payout
    // is tagged with that reference — see settlementDatum.
    txHash: 'fd'.repeat(32),
    outputIndex: 0,
    datum: {
      Position: [
        {
          launch_id: LAUNCH_ID_HEX,
          staker_vkh: fakeKeyHash(0x33),
          staked_amount: 1000n,
          stake_timestamp: 0n,
          ...overrides,
        },
      ],
    },
    assets,
  };
}

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
    ToAddress: vi.fn((...a: unknown[]) => {
      calls.payToAddress = a;
      return builder;
    }),
    // A settlement payout carries the reference of the input it settles, so
    // it is built with ToAddressWithData rather than ToAddress. Recorded into
    // the same list; the datum sits at index 1 and the assets at index 2.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      calls.payToAddress = a;
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
          submit: vi.fn().mockResolvedValue('staking-tx-1'),
        }),
      }),
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('staking-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
  walletAddress?: string,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn(), fromSeed: vi.fn(), fromAPI: vi.fn() },
    // A real UTXO always has a reference, and a settlement output is tagged
    // with it — a fixture without one describes a UTXO the chain cannot make.
    utxosAt: vi.fn().mockResolvedValue(utxos.map((u, i) => ({ txHash: 'fe'.repeat(32), outputIndex: i, ...u }))),
    wallet: () => ({
      address: vi.fn().mockResolvedValue(walletAddress ?? addrFor(fakeKeyHash(0x99))),
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new StakingSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    stakingPoolScriptCbor: '590000',
    launchIdHex: LAUNCH_ID_HEX,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('extendedHexToBech32PrivateKey / keyHashFromAddress (pure helpers)', () => {
  it('extendedHexToBech32PrivateKey accepts a real 64-byte key and rejects a wrong-length one', () => {
    expect(() => extendedHexToBech32PrivateKey(REAL_EXTENDED_KEY_HEX)).not.toThrow();
    expect(() => extendedHexToBech32PrivateKey('aabb')).toThrow(/Expected a 64-byte extended private key/);
  });

  it('keyHashFromAddress derives the real payment credential key hash', () => {
    expect(keyHashFromAddress(addrFor(fakeKeyHash(0x44)))).toBe(fakeKeyHash(0x44));
  });
});

describe('StakingSubmitter.findPoolUtxo / readPoolDatum', () => {
  it('finds the Pool-tagged UTXO matching launch_id, skipping Position-tagged and mismatched entries', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      positionUtxo(),
      poolUtxo({ launch_id: 'other-launch' }),
      poolUtxo({ creator_pub_key_hash: fakeKeyHash(0x55) }),
    ]);
    const result = await submitter.readPoolDatum();
    expect(result.creator_pub_key_hash).toBe(fakeKeyHash(0x55));
  });

  it('throws when staking was never enabled for this launch (no Pool UTXO)', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [positionUtxo()]);
    await expect(submitter.readPoolDatum()).rejects.toThrow(/carries launch .* stakingPool thread NFT/);
  });

  // staking_pool.ak is unparameterized, so one address holds every launch's
  // pool AND every position of every launch. Paying a UTXO there runs no
  // validator, so its datum is a claim by whoever created it.
  it('refuses a Pool UTXO that claims the launch but carries no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo({}, {}, { bare: true })]);
    await expect(submitter.readPoolDatum()).rejects.toThrow(/carries launch .* stakingPool thread NFT/);
  });

  it('refuses to choose when a second Pool UTXO also answers to the launch', async () => {
    // The forger mints under their own policy and names it in their own datum,
    // which satisfies the token check. What they cannot do is arrive alone.
    const { builder } = makeFakeTxBuilder();
    const forgerPolicy = 'ee'.repeat(28);
    const submitter = makeSubmitter(builder, [
      poolUtxo(),
      poolUtxo(
        { thread_nft_policy: forgerPolicy },
        { [forgerPolicy + threadNftAssetName('stakingPool', LAUNCH_ID_HEX)]: 1n },
        { bare: true },
      ),
    ]);
    await expect(submitter.readPoolDatum()).rejects.toThrow(/Refusing to guess/);
  });

  it('does not mistake a Position for the Pool, even carrying the pool NFT', async () => {
    // Both variants share the address, so this is worth pinning — but be
    // precise about what enforces it. Today the NFT check does all the work:
    // a Position datum has no thread_nft_policy field, so no unit derived from
    // one can match, and deleting the Pool-variant check leaves this test
    // green (measured, not assumed). The variant check is kept anyway, because
    // it is the thing that would still hold if a Position ever gained a policy
    // field — at which point the NFT check alone would start accepting one.
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [positionUtxo({}, { [POOL_THREAD_NFT]: 1n })]);
    await expect(submitter.readPoolDatum()).rejects.toThrow(/carries launch .* stakingPool thread NFT/);
  });
});

describe('StakingSubmitter.findPositions', () => {
  it("returns only Position UTXOs matching both launch_id and the staker's own key hash", async () => {
    const { builder } = makeFakeTxBuilder();
    const myHash = fakeKeyHash(0x66);
    const submitter = makeSubmitter(builder, [
      positionUtxo({ staker_vkh: myHash, staked_amount: 100n }),
      positionUtxo({ staker_vkh: fakeKeyHash(0x77), staked_amount: 999n }), // different staker
      positionUtxo({ staker_vkh: myHash, launch_id: 'other-launch' }), // different launch
      poolUtxo(),
    ]);

    const result = await submitter.findPositions(addrFor(myHash));
    expect(result).toHaveLength(1);
    expect(result[0].datum.staked_amount).toBe(100n);
  });
});

describe('StakingSubmitter.stake / stakeWithWallet', () => {
  it('rejects a non-positive stake amount', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()]);
    await expect(submitter.stake('mnemonic', 0n)).rejects.toThrow(/must be positive/);
  });

  it('deposits with a Position datum, no redeemer/SpendingValidator attach (plain permissionless deposit)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x88);
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(stakerHash));

    await submitter.stake('mnemonic', 500n, 1_700_000_000_000);

    expect(calls.collectFrom).toBeUndefined();
    expect(calls.attachSpendingValidator).toBeUndefined();
    const [_addr, payload, assets] = calls.payToContract as [
      string,
      { value: { Position: [Record<string, unknown>] } },
      Record<string, bigint>,
    ];
    expect(payload.value.Position[0].staker_vkh).toBe(stakerHash);
    expect(payload.value.Position[0].staked_amount).toBe(500n);
    expect(payload.value.Position[0].stake_timestamp).toBe(1_700_000_000_000n);
    expect(assets.lovelace).toBe(2_000_000n); // MIN_UTXO_LOVELACE
    expect(assets[TOKEN_UNIT]).toBe(500n);
  });

  it('requires the staker as signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x11);
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(stakerHash));
    await submitter.stake('mnemonic', 100n);
    expect(calls.addSigner).toEqual([addrFor(stakerHash)]);
  });
});

describe('StakingSubmitter.unstake / unstakeWithWallet', () => {
  it('rejects unstaking a position that does not belong to the connected wallet', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, []);
    const position: StakingPosition = {
      utxo: positionUtxo({ staker_vkh: fakeKeyHash(0x22) }) as never,
      datum: { staker_vkh: fakeKeyHash(0x22) } as never,
    };
    await expect(submitter.unstake('mnemonic', position)).rejects.toThrow(/does not belong to the connected wallet/);
  });

  it("builds the Unstake redeemer (Constr 0, no fields) and pays the position's full value back to the staker", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x99);
    const submitter = makeSubmitter(builder, [], addrFor(stakerHash));
    const posAssets = { lovelace: 2_000_000n, [TOKEN_UNIT]: 1000n };
    const position: StakingPosition = {
      utxo: { ...positionUtxo({ staker_vkh: stakerHash }, posAssets) } as never,
      datum: { staker_vkh: stakerHash, staked_amount: 1000n } as never,
    };

    await submitter.unstake('mnemonic', position);

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(0);
    expect(redeemer.fields).toEqual([]);
    const payToAddress = calls.payToAddress as [string, unknown, Record<string, bigint>];
    expect(payToAddress[0]).toBe(addrFor(stakerHash));
    expect(payToAddress[2]).toBe(posAssets);
  });
});

describe('StakingSubmitter.claimRewards / claimRewardsWithWallet (permissionless)', () => {
  it('refuses a claim against a bit that is already spent', async () => {
    const { builder } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x33);
    const submitter = makeSubmitter(builder, [poolUtxo({ claimed_bits: '8000' })], addrFor(stakerHash));
    await expect(submitter.claimRewards('mnemonic', 500n, 0, [])).rejects.toThrow(/already been claimed/);
  });

  it('refuses a leaf index outside the current root nullifier', async () => {
    const { builder } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x33);
    const submitter = makeSubmitter(builder, [poolUtxo({ claimed_bits: '0000' })], addrFor(stakerHash));
    // Two bytes hold 16 bits, so bit 16 does not exist.
    await expect(submitter.claimRewards('mnemonic', 500n, 16, [])).rejects.toThrow(/outside this root/);
  });

  it('refuses a non-positive payout', async () => {
    const { builder } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x33);
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(stakerHash));
    await expect(submitter.claimRewards('mnemonic', 0n, 0, [])).rejects.toThrow(/must be positive/);
  });

  it('sets only the claiming staker\u2019s bit, leaving every other bit alone', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x44);
    const submitter = makeSubmitter(
      builder,
      // Somebody else already claimed bit 0; this staker holds bit 9, which is
      // in the SECOND byte — the boundary a bitmap is most likely to get wrong.
      [poolUtxo({ claimed_bits: '8000' }, { [TOKEN_UNIT]: 10_000n })],
      addrFor(stakerHash),
    );

    const result = await submitter.claimRewards('mnemonic', 500n, 9, []);
    expect(result.payout).toBe(500n);

    const payload = calls.payToContract![1] as {
      value: { Pool: [Record<string, unknown>] };
    };
    expect(payload.value.Pool[0].claimed_bits).toBe('8040');
  });

  it('pays exactly what the leaf says, with no running total to subtract', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x66);
    const submitter = makeSubmitter(
      builder,
      [poolUtxo({ claimed_bits: '0000' }, { [TOKEN_UNIT]: 10_000n })],
      addrFor(stakerHash),
    );

    const result = await submitter.claimRewards('mnemonic', 250n, 0, []);
    expect(result.payout).toBe(250n);
    const payload = calls.payToContract![1] as {
      value: { Pool: [Record<string, unknown>] };
    };
    expect(payload.value.Pool[0].claimed_bits).toBe('8000');
  });

  it("pays the delta in the launch token to the staker's address", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x77);
    const submitter = makeSubmitter(
      builder,
      [poolUtxo({ claimed_bits: '0000' }, { [TOKEN_UNIT]: 10_000n })],
      addrFor(stakerHash),
    );

    await submitter.claimRewards('mnemonic', 250n, 0, []);
    const payToAddress = calls.payToAddress as [string, { kind: string; value: string }, Record<string, bigint>];
    expect(payToAddress[0]).toBe(addrFor(stakerHash));
    expect(payToAddress[2][TOKEN_UNIT]).toBe(250n);
    // The reward output names the POOL utxo it is paid from. Without the tag
    // this same output would also answer an obligation another contract owes
    // this staker, and the pool would be debited for a payment it never made.
    const spent = calls.collectFrom![0] as Array<{ txHash: string; outputIndex: number }>;
    expect(payToAddress[1]).toEqual({
      kind: 'inline',
      value: settlementDatum(spent[0]!),
    });
  });

  it('is genuinely permissionless — no addSigner call at all, since "the proof is the authorization"', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x88);
    const submitter = makeSubmitter(
      builder,
      [poolUtxo({ claimed_bits: '0000' }, { [TOKEN_UNIT]: 10_000n })],
      addrFor(stakerHash),
    );
    await submitter.claimRewards('mnemonic', 250n, 0, []);
    expect(calls.addSigner).toBeUndefined();
  });

  it('builds the ClaimRewards redeemer (index 1) with real MerkleProofStep Constr encoding (goesLeft as Constr 1/0, not a raw boolean)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const stakerHash = fakeKeyHash(0x11);
    const submitter = makeSubmitter(
      builder,
      [poolUtxo({ claimed_bits: '0000' }, { [TOKEN_UNIT]: 10_000n })],
      addrFor(stakerHash),
    );

    await submitter.claimRewards('mnemonic', 250n, 0, [
      { sibling: 'aa'.repeat(32), goesLeft: true },
      { sibling: 'bb'.repeat(32), goesLeft: false },
    ]);

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(1);
    const [vkh, payout, leafIndex, proofArg] = redeemer.fields as [string, bigint, bigint, Constr<unknown>[]];
    expect(vkh).toBe(stakerHash);
    expect(payout).toBe(250n);
    expect(leafIndex).toBe(0n);
    expect(proofArg[0].index).toBe(0);
    expect((proofArg[0].fields[1] as Constr<unknown>).index).toBe(1); // goesLeft=true -> Constr 1
    expect((proofArg[1].fields[1] as Constr<unknown>).index).toBe(0); // goesLeft=false -> Constr 0
  });
});

describe('StakingSubmitter.topUpPool / topUpPoolWithWallet (creator-only)', () => {
  it('rejects a non-positive top-up amount', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(CREATOR_KEY_HASH));
    await expect(submitter.topUpPool(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 0n)).rejects.toThrow(
      /must be positive/,
    );
  });

  it('rejects when the signing address is not the launch creator', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(fakeKeyHash(0xff)));
    await expect(submitter.topUpPool(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0xff)), 100n)).rejects.toThrow(
      /Only the launch creator can top up/,
    );
  });

  it("increases the pool's real token balance and builds the TopUpPool redeemer (index 2)", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo({}, { [TOKEN_UNIT]: 1000n })], addrFor(CREATOR_KEY_HASH));

    await submitter.topUpPool(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 500n);

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(2);
    expect(redeemer.fields).toEqual([500n]);
    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    expect(assetsArg[TOKEN_UNIT]).toBe(1500n);
  });
});

describe('StakingSubmitter.publishRewardRoot (governor-only)', () => {
  it('rejects when the signing address is not the governor', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(fakeKeyHash(0xff)));
    await expect(
      submitter.publishRewardRoot(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0xff)), toHex(new Uint8Array(32)), 4),
    ).rejects.toThrow(/Only the governor can publish/);
  });

  it('updates reward_root and builds the PublishRewardRoot redeemer (index 3)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(GOVERNOR_KEY_HASH));
    const newRoot = toHex(new Uint8Array(32).fill(7));

    // 20 stakers need 3 bytes of nullifier (24 bits); 16 would need exactly 2.
    await submitter.publishRewardRoot(REAL_EXTENDED_KEY_HEX, addrFor(GOVERNOR_KEY_HASH), newRoot, 20);

    const redeemer = calls.collectFrom![1] as Constr<unknown>;
    expect(redeemer.index).toBe(3);
    expect(redeemer.fields).toEqual([newRoot, '000000']);
    const payload = calls.payToContract![1] as {
      value: { Pool: [Record<string, unknown>] };
    };
    expect(payload.value.Pool[0].reward_root).toBe(newRoot);
    expect(payload.value.Pool[0].claimed_bits).toBe('000000');
  });

  // A new root is a new roster, and every bit of its nullifier must start
  // clear — otherwise publishing one could burn a staker's claim before that
  // staker ever made it.
  it('replaces a used nullifier with a cleared one, so a staker can claim again', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo({ claimed_bits: 'ff' })], addrFor(GOVERNOR_KEY_HASH));

    await submitter.publishRewardRoot(REAL_EXTENDED_KEY_HEX, addrFor(GOVERNOR_KEY_HASH), 'aa'.repeat(32), 8);

    const payload = calls.payToContract![1] as {
      value: { Pool: [Record<string, unknown>] };
    };
    expect(payload.value.Pool[0].claimed_bits).toBe('00');
  });

  it('refuses to publish a root with no stakers to pay', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [poolUtxo()], addrFor(GOVERNOR_KEY_HASH));
    await expect(
      submitter.publishRewardRoot(REAL_EXTENDED_KEY_HEX, addrFor(GOVERNOR_KEY_HASH), 'aa'.repeat(32), 0),
    ).rejects.toThrow(/positive whole number/);
  });
});
