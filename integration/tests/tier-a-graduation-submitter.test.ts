// Tests for tier-a-graduation-submitter.ts's TierAGraduationSubmitter — the
// two-transaction graduation flow (split after a real Preprod tx-size
// overflow) — TX1 = Graduate (bonding_curve) + SealLock (lp_escrow) in one
// tx, TX2 = StartVesting (vesting) separately, awaited between. Covers the
// real value-movement invariants this file's own header derives from each
// contract's helper functions (graduation_funds_left_curve,
// lp_seeding_output_ok) and the total_raised > 0 precondition. Same
// importOriginal partial-mock Lucid strategy as the other submitter tests.

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
import { TierAGraduationSubmitter } from '../tier-a-graduation-submitter.js';
import { type ThreadNftRole, threadNftAssetName } from '../tier-a-schemas.js';

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
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-grad-1'));
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_ASSET_NAME;
const GOVERNOR_ADDR = addrFor(fakeKeyHash(0x11));
const THREAD_POLICY = 'cc'.repeat(28);

/** The unit a real launch's state UTXO carries for one role. */
const threadNft = (role: ThreadNftRole) => THREAD_POLICY + threadNftAssetName(role, LAUNCH_ID_HEX);

function curveDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    curve_state: 'Graduated',
    total_raised: 10_000_000n,
    lp_reserve_tokens: 150_000_000n,
    staking_reserve_tokens: 250_000_000n,
    lp_seeded: false,
    staking_seeded: false,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function lpDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    lock_timestamp: 0n,
    lp_state: 'Unlocked',
    lp_token_amount: 150_000_000n,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function vestDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    vesting_state: 'NotStarted',
    vest_start_timestamp: 0n,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const collectFromCalls: unknown[][] = [];
  const attachCalls: unknown[][] = [];
  const payToContractCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    collectFromCalls.push(a);
    return builder;
  });
  // These builders now set a validity range, because the redeemers they build
  // bind their timestamp to it. Recorded like every other call so a test can
  // assert the range actually brackets the timestamp it sent.
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      attachCalls.push(a);
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      payToContractCalls.push(a);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn((...a: unknown[]) => {
    calls.complete = a;
    return Promise.resolve({
      sign: {
        withPrivateKey: () => ({
          complete: vi.fn().mockResolvedValue({
            submit: vi.fn().mockResolvedValue(nextTxHash()),
          }),
        }),
      },
    });
  });
  return { builder, calls, collectFromCalls, attachCalls, payToContractCalls };
}

let txHashCounter = 0;
function nextTxHash() {
  txHashCounter++;
  return `grad-tx-${txHashCounter}`;
}

const addressRefs = { curve: '', lp: '', vesting: '' };

interface FixtureUtxo {
  datum: unknown;
  assets: Record<string, bigint>;
  /** Opt out of the thread NFT, to describe a UTXO that genuinely lacks one. */
  noThreadNft?: boolean;
  txHash?: string;
}

/**
 * Every state UTXO a real launch has carries its role's thread NFT — that is
 * what the lookup authenticates on, and no launch has produced one without it
 * since the NFTs were introduced. Added here rather than in each fixture so a
 * test says only what it is actually about, and merged UNDER the fixture's own
 * assets so an explicit value still wins.
 */
function asChainUtxos(role: ThreadNftRole, utxos: FixtureUtxo[] | undefined) {
  return (utxos ?? []).map((u, i) => ({
    txHash: u.txHash ?? i.toString(16).padStart(2, '0').repeat(32),
    outputIndex: 0,
    ...u,
    assets: u.noThreadNft ? u.assets : { [threadNft(role)]: 1n, ...u.assets },
  }));
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    curveUtxos?: FixtureUtxo[];
    lpUtxos?: FixtureUtxo[];
    vestingUtxos?: FixtureUtxo[];
  } = {},
) {
  const awaitTx = vi.fn().mockResolvedValue(true);
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.curve) return Promise.resolve(asChainUtxos('bondingCurve', opts.curveUtxos));
      if (address === addressRefs.lp) return Promise.resolve(asChainUtxos('lpEscrow', opts.lpUtxos));
      if (address === addressRefs.vesting) return Promise.resolve(asChainUtxos('vesting', opts.vestingUtxos));
      return Promise.resolve([]);
    }),
    awaitTx,
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new TierAGraduationSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    bondingCurveScriptCbor: '590001',
    lpEscrowScriptCbor: '590002',
    vestingScriptCbor: '590003',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
  addressRefs.curve = (submitter as unknown as { bondingCurveAddress: string }).bondingCurveAddress;
  addressRefs.lp = (submitter as unknown as { lpEscrowAddress: string }).lpEscrowAddress;
  addressRefs.vesting = (submitter as unknown as { vestingAddress: string }).vestingAddress;

  return { submitter, fakeLucid };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
  txHashCounter = 0;
});

// bonding_curve.ak, lp_escrow.ak and vesting.ak are all unparameterized, so
// every launch's UTXO of each kind sits at one shared address and anyone can
// pay another one there with any datum they care to write. Matching the datum's
// launch_id alone matched that claim.
describe('TierAGraduationSubmitter — which UTXO it graduates', () => {
  it('refuses a curve UTXO that claims the launch but carries no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {}, noThreadNft: true }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurve thread NFT/,
    );
  });

  it('graduates the genuine curve when a forged one is planted beside it', async () => {
    // A forger can mint under their own policy and name it in their own datum,
    // which satisfies any token check derived from that datum. It does not
    // satisfy one derived from the policy the platform recorded at mint, so
    // the planted UTXO is not a candidate and the real one is chosen outright.
    const { builder, collectFromCalls } = makeFakeTxBuilder();
    const planted = {
      datum: curveDatum({ thread_nft_policy: 'ee'.repeat(28) }),
      assets: { ['ee'.repeat(28) + threadNftAssetName('bondingCurve', LAUNCH_ID_HEX)]: 1n },
      noThreadNft: true,
      txHash: '22'.repeat(32),
    };
    const { submitter } = makeSubmitter(builder, {
      // Planted FIRST: the shape this replaced took the first match, and
      // provider ordering is not something an honest caller controls.
      curveUtxos: [planted, { datum: curveDatum(), assets: {}, txHash: '11'.repeat(32) }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    const spentCurve = collectFromCalls[0]?.[0] as Array<{ txHash: string }>;
    expect(spentCurve[0]?.txHash).toBe('11'.repeat(32));
  });

  it('still refuses when two UTXOs both carry the genuine thread NFT', async () => {
    // Unreachable while the thread NFT policy is one-shot — which is a property
    // of that policy, not of the lookup, so the lookup keeps its own guard.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        { datum: curveDatum(), assets: {}, txHash: '11'.repeat(32) },
        { datum: curveDatum(), assets: {}, txHash: '22'.repeat(32) },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Refusing to guess/,
    );
  });

  it('refuses an LP escrow UTXO with no thread NFT, not only the curve', async () => {
    // Each of the three addresses is looked up separately, so each needs its
    // own evidence — a check that reached only the first would still leave the
    // other two selecting on a claim.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {}, noThreadNft: true }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* lpEscrow thread NFT/,
    );
  });

  it('refuses a vesting UTXO with no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {}, noThreadNft: true }],
    });
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* vesting thread NFT/,
    );
  });

  it('ignores another launch’s UTXO sitting at the same address', async () => {
    const { builder } = makeFakeTxBuilder();
    const otherLaunch = toHex(new TextEncoder().encode('launch-grad-2'));
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({ launch_id: otherLaunch }),
          assets: { [THREAD_POLICY + threadNftAssetName('bondingCurve', otherLaunch)]: 1n },
          noThreadNft: true,
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurve thread NFT/,
    );
  });
});

describe('TierAGraduationSubmitter.graduateAndSealLp — guard rails', () => {
  it('rejects when the curve is not Graduated', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ curve_state: 'Active' }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Curve is not Graduated/,
    );
  });

  it('rejects when Graduate already ran (lp_seeded or staking_seeded already true)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ lp_seeded: true }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Graduate already ran/,
    );
  });

  it('rejects when SealLock already ran (lock_timestamp already set)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum({ lock_timestamp: 12345n }), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /SealLock already ran/,
    );
  });

  it('rejects when total_raised is not positive (a heavily-net-sold curve reaching 100% should not seed a zero/negative LP)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 0n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /total_raised .* is not positive/,
    );
  });
});

describe('TierAGraduationSubmitter.graduateAndSealLp — value movement', () => {
  it('moves lpAda + reserve tokens OUT of the curve and INTO lp_escrow, exactly (graduation_funds_left_curve / lp_seeding_output_ok)', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 5_000_000n,
            lp_reserve_tokens: 100n,
            staking_reserve_tokens: 50n,
          }),
          assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      lpUtxos: [
        {
          datum: lpDatum({ lp_token_amount: 100n }),
          assets: { lovelace: 2_000_000n },
        },
      ],
    });

    const result = await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    expect(result.lpAda).toBe(5_000_000n);
    expect(result.lpReserveTokens).toBe(100n);
    expect(result.stakingReserveTokens).toBe(50n);

    const [, curvePayload, curveAssets] = payToContractCalls[0] as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(curveAssets.lovelace).toBe(15_000_000n); // 20,000,000 - 5,000,000
    expect(curveAssets[TOKEN_UNIT]).toBe(999_850n); // 1,000,000 - (100+50)
    expect(curvePayload.value.total_raised).toBe(0n);
    expect(curvePayload.value.lp_seeded).toBe(true);
    expect(curvePayload.value.staking_seeded).toBe(true);

    const [, lpPayload, lpAssets] = payToContractCalls[1] as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(lpAssets.lovelace).toBe(7_000_000n); // 2,000,000 + 5,000,000
    expect(lpAssets[TOKEN_UNIT]).toBe(100n); // exactly lp_token_amount
    expect(lpPayload.value.lock_timestamp).toBe(1_700_000_000n);
    expect(lpPayload.value.lp_state).toBe('Locked');
  });

  it('omits a token unit that computes to exactly zero (curve_own_output_clean / lp_own_output_clean)', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 1n,
            lp_reserve_tokens: 100n,
            staking_reserve_tokens: 0n,
          }),
          assets: { lovelace: 10n, [TOKEN_UNIT]: 100n },
        },
      ],
      lpUtxos: [{ datum: lpDatum({ lp_token_amount: 0n }), assets: { lovelace: 0n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    const [, , curveAssets] = payToContractCalls[0] as [string, unknown, Record<string, bigint>];
    expect(curveAssets[TOKEN_UNIT]).toBeUndefined(); // 100 - 100 = 0, pruned
    const [, , lpAssets] = payToContractCalls[1] as [string, unknown, Record<string, bigint>];
    expect(lpAssets[TOKEN_UNIT]).toBeUndefined(); // lp_token_amount 0, pruned
  });

  it('builds the Graduate (index 8, no fields) and SealLock (index 0, [timestamp, lpAda]) redeemers correctly', async () => {
    const { builder, collectFromCalls, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 42n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 999);

    const graduateRedeemer = collectFromCalls[0][1] as {
      index: number;
      fields: unknown[];
    };
    expect(graduateRedeemer.index).toBe(8);
    expect(graduateRedeemer.fields).toEqual([]);

    const sealLockRedeemer = collectFromCalls[1][1] as {
      index: number;
      fields: unknown[];
    };
    expect(sealLockRedeemer.index).toBe(0);
    expect(sealLockRedeemer.fields).toEqual([999n, 42n]);
    // The redeemer's timestamp is bound to this range on chain, and the range
    // is capped at ten minutes wide. Recording the calls is not enough -- a
    // mock that merely swallows validFrom would let an absent or mismatched
    // range pass unnoticed, which is exactly how this defect survived.
    const from = calls.validFrom?.[0] as number;
    const to = calls.validTo?.[0] as number;
    expect(from).toBeLessThanOrEqual(999);
    expect(to).toBeGreaterThanOrEqual(999);
    expect(to - from).toBeLessThanOrEqual(600_000);
  });

  it('requires the governor as signer and passes localUPLCEval: false to complete() (multi-script eval)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
    expect(calls.complete).toEqual([{ localUPLCEval: false }]);
  });
});

describe('TierAGraduationSubmitter.startVesting', () => {
  it('rejects when vesting is not NotStarted', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }],
    });
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /StartVesting already ran/,
    );
  });

  it('transitions to Vesting and stamps vest_start_timestamp (POSIX seconds)', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });

    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const [, payload] = payToContractCalls[0] as [string, { value: Record<string, unknown> }];
    expect(payload.value.vesting_state).toBe('Vesting');
    expect(payload.value.vest_start_timestamp).toBe(1_700_000_000n);
  });

  it("re-locks the vesting UTXO's own assets unchanged (StartVesting has no value-movement check at all)", async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const existingAssets = { lovelace: 2_000_000n, [TOKEN_UNIT]: 500n };
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: existingAssets }],
    });

    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    const [, , assetsArg] = payToContractCalls[0] as [string, unknown, Record<string, bigint>];
    // By value, not identity. The old assertion was `toBe(existingAssets)`,
    // which held only because the fixture object was handed straight back —
    // it would have passed just as well against a builder that never read the
    // UTXO. The thread NFT belongs in the expectation for the same reason it
    // belongs on the UTXO: re-locking "its own assets" has to carry it, or
    // the next lookup finds nothing.
    expect(assetsArg).toStrictEqual({ ...existingAssets, [threadNft('vesting')]: 1n });
  });

  it('requires the governor as signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });
    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
  });
});

describe('TierAGraduationSubmitter.graduate (sequencing convenience wrapper)', () => {
  it("runs graduateAndSealLp then awaits TX1 before starting TX2, returning both hashes and step1's figures", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, fakeLucid } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 777n,
            lp_reserve_tokens: 10n,
            staking_reserve_tokens: 5n,
          }),
          assets: {},
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });

    const result = await submitter.graduate(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    expect(fakeLucid.awaitTx).toHaveBeenCalledWith('grad-tx-1');
    expect(result.graduateSealLockTxHash).toBe('grad-tx-1');
    expect(result.startVestingTxHash).toBe('grad-tx-2');
    expect(result.lpAda).toBe(777n);
    expect(result.lpReserveTokens).toBe(10n);
    expect(result.stakingReserveTokens).toBe(5n);
  });

  it("wraps a TX2 failure with TX1's hash so a caller can retry only startVesting, not re-run graduate()", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 1n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }], // makes step2 fail
    });

    await expect(submitter.graduate(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /graduateAndSealLp succeeded \(txHash: grad-tx-1\) but startVesting failed.*Retry with startVesting\(\) directly/s,
    );
  });
});
