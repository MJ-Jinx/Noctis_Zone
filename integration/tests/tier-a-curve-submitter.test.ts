// Tests for tier-a-curve-submitter.ts's LucidTierACurveSubmitter — the
// heaviest submitter in this codebase: 6 real on-chain actions
// (activateCurve, buyTokens, sellTokens, expireCurve, claimBuyback, each
// with real embedded business logic mirroring bonding_curve.ak's own
// verify_price/verify_fee_slice/update_purchases exactly, per this file's
// own header — including two real, previously-discovered-on-chain gotchas:
// existing-buyer entries must be updated IN PLACE, not filter-then-append
// (list order matters to the validator's structural equality check), and
// ExpireCurve's validity range must be built from a HONEST Date.now(), not
// a caller-suppliable timestamp (a stale range gets silently dropped by the
// ledger rather than erroring). Same importOriginal partial-mock Lucid
// strategy as the other submitter tests — getAddressDetails/CML stay real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator, capAccumulatorFromHex } from '../cap-accumulator-tree.js';
import {
  buyCost,
  curvePriceAt,
  extendedHexToBech32PrivateKey,
  feeSlice,
  LucidTierACurveSubmitter,
  toHex,
} from '../tier-a-curve-submitter.js';
import type { BondingCurveDatumData } from '../tier-a-schemas.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

/// Every fixture below starts from a curve nothing has been taken from, so the
/// accumulator is empty and each buyer proves their own empty slot — the same
/// state genesis writes. A fresh instance per call, since a submitter that
/// mutated a shared one would make the tests order-dependent.
function emptyCapState(): CapAccumulator {
  return new CapAccumulator();
}

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

const REAL_EXTENDED_KEY_HEX = (() => {
  const pk = CML.PrivateKey.generate_ed25519extended();
  return toHex(pk.to_raw_bytes());
})();

const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-tier-a-1'));
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('bondingCurve', LAUNCH_ID_HEX);
// A real UTXO always has a reference, and settlement outputs are tagged with
// it — a fixture without one describes a UTXO the chain cannot produce, and
// hides every code path that reads it.
/** What ToAddressWithData is handed as its datum argument. `Data.to` is mocked
 *  to identity in this file, so the tag arrives as the decoded object rather
 *  than CBOR — which makes the assertion read as what it means. */
interface InlineDatumArg {
  kind: string;
  value: unknown;
}

/** The tag a payout must carry to settle the curve UTXO at `fe…#index`. */
function settlesCurveInput(index: number): InlineDatumArg {
  return { kind: 'inline', value: { transaction_id: 'fe'.repeat(32), output_index: BigInt(index) } };
}

const withThreadNft = <T extends { assets?: Record<string, bigint> }>(list: T[]): T[] =>
  list.map((u, i) => ({
    txHash: 'fe'.repeat(32),
    outputIndex: i,
    ...u,
    assets: { [THREAD_UNIT]: 1n, ...(u.assets ?? {}) },
  }));

const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const CREATOR_KEY_HASH = fakeKeyHash(0x99);

function baseDatum(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    creator_pub_key_hash: CREATOR_KEY_HASH,
    base_price: 10n,
    max_price: 1000n,
    curve_supply: 1_000_000n,
    curve_state: 'Inactive',
    activated_at: 0n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: 500_000n,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    // The cumulative cap's accumulator at genesis: every slot empty, matching
    // emptyCapState() below. A submitter refuses to build against a state that
    // does not derive this, so the two have to agree.
    cap_root: bytesToHex(CAP_EMPTY_ROOT),
    ...overrides,
  };
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const payToAddressCalls: unknown[][] = [];
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
      payToAddressCalls.push(a);
      return builder;
    }),
    // A settlement payout names the spend it settles, so it is built with
    // ToAddressWithData rather than ToAddress. Recorded into the same list so
    // a test can assert on the payout without caring which was used — and so
    // that a payout losing its tag shows up as a shape change here.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('tier-a-tx-1'),
        }),
      }),
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('tier-a-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls, payToAddressCalls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
  walletAddress?: string,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn(), fromSeed: vi.fn(), fromAPI: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    wallet: () => ({
      address: vi.fn().mockResolvedValue(walletAddress ?? addrFor(fakeKeyHash(0x11))),
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return {
    submitter: new LucidTierACurveSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      compiledScriptCbor: '590000',
      launchIdHex: LAUNCH_ID_HEX,
    }),
    fakeLucid,
  };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Pure helpers
// ============================================================================

describe('feeSlice', () => {
  it('floors each slice, leaving any remainder with the curve', () => {
    expect(feeSlice(1_000_000n, 100n)).toBe(10_000n);
    expect(feeSlice(999n, 100n)).toBe(9n); // floor(9.99), never rounded up
  });
});

describe('buyCost (summed over the range, mirroring the validator)', () => {
  const datum = {
    base_price: 10n,
    max_price: 1000n,
    curve_supply: 1000n,
  } as BondingCurveDatumData;

  it('charges one token the price at its own position', () => {
    // 10 + 990*500/1000 = 505
    expect(buyCost(datum, 500n, 1n)).toBe(505n);
    expect(curvePriceAt(datum, 500n)).toBe(505n);
  });

  it('charges a batch the sum of its members, not one price times the count', () => {
    const spot = buyCost(datum, 0n, 1n);
    expect(buyCost(datum, 0n, 100n)).toBeGreaterThan(spot * 100n);
  });

  it('is additive over adjacent ranges, so splitting a trade changes nothing', () => {
    expect(buyCost(datum, 0n, 400n) + buyCost(datum, 400n, 600n)).toBe(buyCost(datum, 0n, 1000n));
  });

  it('prices a partial trade on a curve whose range and supply share no factor', () => {
    // Every position must yield a definite lovelace amount, including those
    // where the underlying price is not a whole number.
    const awkward = {
      base_price: 1n,
      max_price: 2n,
      curve_supply: 3n,
    } as BondingCurveDatumData;
    expect(buyCost(awkward, 1n, 1n)).toBe(2n);
    expect(buyCost(awkward, 0n, 3n)).toBe(4n);
  });
});

describe('extendedHexToBech32PrivateKey', () => {
  it('accepts a real 64-byte extended key and rejects a wrong-length one', () => {
    expect(() => extendedHexToBech32PrivateKey(REAL_EXTENDED_KEY_HEX)).not.toThrow();
    expect(() => extendedHexToBech32PrivateKey('aabb')).toThrow(/Expected a 64-byte extended private key/);
  });
});

// ============================================================================
// activateCurve
// ============================================================================

describe('LucidTierACurveSubmitter.activateCurve', () => {
  it('rejects once the curve is no longer Inactive', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);

    await expect(
      submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), Date.now()),
    ).rejects.toThrow(/Curve is not Inactive/);
  });

  it('sets curve_state to Active and stamps activated_at with the given timestamp', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 1_753_000_000_000);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.curve_state).toBe('Active');
    expect(payload.value.activated_at).toBe(1_753_000_000_000n);
  });

  it('sets a validity range spanning both the claimed timestamp and the real current time (supports legitimate backdating)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    const backdatedMs = Date.now() - 100_000_000; // far in the past — legitimate stall-testing backdate

    const before = Date.now();
    await submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), backdatedMs);
    const after = Date.now();

    const validFrom = calls.validFrom![0] as number;
    const validTo = calls.validTo![0] as number;
    expect(validFrom).toBeLessThanOrEqual(backdatedMs - 60_000 + 1);
    expect(validTo).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(validTo).toBeLessThanOrEqual(after + 60_000 + 1000);
  });

  it('requires the governor address as signer and selects the wallet via fromAddress (base-address coin selection)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const governorAddr = addrFor(fakeKeyHash(0x33));
    const { submitter, fakeLucid } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.activateCurve(REAL_EXTENDED_KEY_HEX, governorAddr, Date.now());

    expect(calls.addSigner).toEqual([governorAddr]);
    expect(fakeLucid.selectWallet.fromAddress).toHaveBeenCalled();
  });
});

// ============================================================================
// buyTokens
// ============================================================================

describe('LucidTierACurveSubmitter.buyTokens', () => {
  it('rejects when the curve is not Active', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Inactive' }), assets: {} }]);
    await expect(submitter.buyTokens('mnemonic', 100n, emptyCapState())).rejects.toThrow(/Curve is not Active/);
  });

  it('rejects a tokenAmount of 0 or exceeding remaining supply', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          curve_supply: 100n,
          tokens_sold: 90n,
        }),
        assets: {},
      },
    ]);
    await expect(submitter.buyTokens('mnemonic', 0n, emptyCapState())).rejects.toThrow(/token_amount out of range/);
    await expect(submitter.buyTokens('mnemonic', 11n, emptyCapState())).rejects.toThrow(/token_amount out of range/);
  });

  it('allows the creator to buy their own curve, and blocks them from selling', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [{ datum: baseDatum({ curve_state: 'Active', tokens_sold: 500n }), assets: { lovelace: 10_000_000n } }],
      addrFor(CREATOR_KEY_HASH),
    );
    // A creator may put ADA in. They can never take it out, so there is no
    // round trip to wash-trade with, and their buys are flagged to the
    // community by the trade-history reader.
    await expect(submitter.buyTokens('mnemonic', 100n, emptyCapState())).resolves.toBeTruthy();
    await expect(submitter.sellTokens('mnemonic', 100n, emptyCapState())).rejects.toThrow(/creator cannot sell/i);
  });

  it('rejects a single purchase over the per-transaction cap (unless skipClientCapCheck)', async () => {
    const { builder } = makeFakeTxBuilder();
    const buyerHash = fakeKeyHash(0x44);
    const { submitter } = makeSubmitter(
      builder,
      [{ datum: baseDatum({ curve_state: 'Active', wallet_cap: 100n }), assets: {} }],
      addrFor(buyerHash),
    );
    // The cap is CUMULATIVE: what this wallet has already taken plus this buy.
    await expect(submitter.buyTokens('mnemonic', 101n, emptyCapState())).rejects.toThrow(/Cumulative cap exceeded/);
    await expect(submitter.buyTokens('mnemonic', 100n, emptyCapState())).resolves.toBeTruthy();
    // Splitting across transactions no longer buys headroom — the second buy
    // is rejected on the FIRST one's total, which is the whole point.
    // The curve datum has to carry the root this prior state derives, or the
    // submitter would refuse it as stale before ever reaching the cap check.
    const priorState = capAccumulatorFromHex([{ keyHashHex: buyerHash, total: '60' }]);
    const { submitter: traded } = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            wallet_cap: 100n,
            cap_root: bytesToHex(priorState.root),
          }),
          assets: {},
        },
      ],
      addrFor(buyerHash),
    );
    await expect(traded.buyTokens('mnemonic', 50n, priorState)).rejects.toThrow(/Cumulative cap exceeded/);
    await expect(traded.buyTokens('mnemonic', 40n, priorState)).resolves.toBeTruthy();
    // skipClientCapCheck bypasses only the client-side guard, used to prove
    // the on-chain check is real.
    await expect(submitter.buyTokens('mnemonic', 101n, emptyCapState(), true)).resolves.toBeTruthy();
  });

  it('prices at the PRE-buy tokens_sold point and computes exact fee slices', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          base_price: 10n,
          max_price: 1010n,
          curve_supply: 1000n,
          tokens_sold: 0n,
        }),
        assets: {},
      },
    ]);

    // base=10, max=1010, supply=1000: buying the whole curve costs the sum of
    // P(0)..P(999), which is 509,500 — well above 1000 x the 10-lovelace spot
    // price at the start, because each token is priced where it sits.
    const result = await submitter.buyTokens('mnemonic', 1000n, emptyCapState());
    expect(result.grossPayment).toBe(509_500n);
    expect(result.avgPrice).toBe(509n);

    const redeemer = calls.collectFrom![1] as {
      index: number;
      fields: unknown[];
    };
    expect(redeemer.index).toBe(1); // BuyTokens constructor index
    // The redeemer carries only the amount and the buyer — price and fees are
    // the contract's own computation, not a caller's claim.
    // token_amount, buyer_key_hash, then the two cumulative-cap fields.
    expect(redeemer.fields).toHaveLength(4);
    expect(redeemer.fields[0]).toBe(1000n);
  });

  it('transitions curve_state to Graduated when this buy fully sells through the curve', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          base_price: 100n,
          max_price: 100n,
          curve_supply: 100n,
          tokens_sold: 90n,
          wallet_cap: 1000n,
        }),
        assets: {},
      },
    ]);

    // price is constant 100 (base==max); grossPayment = 100*10 = 1000, a
    // multiple of 500, satisfying the exact-fee-slice requirement.
    await submitter.buyTokens('mnemonic', 10n, emptyCapState());

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.tokens_sold).toBe(100n);
    expect(payload.value.curve_state).toBe('Graduated');
  });

  it('buyTokensWithWallet signs via selectWallet.fromAPI instead of fromSeed', async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'buyer-wallet-api' };
    const { submitter, fakeLucid } = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          base_price: 10n,
          max_price: 10n,
          curve_supply: 10000n,
          wallet_cap: 100000n,
        }),
        assets: {},
      },
    ]);

    await submitter.buyTokensWithWallet(walletApi as never, 10000n, emptyCapState());
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
    expect(fakeLucid.selectWallet.fromSeed).not.toHaveBeenCalled();
  });
});

// ============================================================================
// sellTokens
// ============================================================================

describe('LucidTierACurveSubmitter.sellTokens', () => {
  it('rejects when the curve is not Active', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Inactive' }), assets: {} }]);
    await expect(submitter.sellTokens('mnemonic', 10n, emptyCapState())).rejects.toThrow(/Curve is not Active/);
  });

  it('rejects a non-positive tokenAmount', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await expect(submitter.sellTokens('mnemonic', 0n, emptyCapState())).rejects.toThrow(/must be positive/);
  });

  it('rejects a creator selling into their own curve', async () => {
    const { builder } = makeFakeTxBuilder();
    const creatorHash = fakeKeyHash(0x11);
    const { submitter } = makeSubmitter(
      builder,
      [{ datum: baseDatum({ curve_state: 'Active', creator_pub_key_hash: creatorHash }), assets: {} }],
      addrFor(creatorHash),
    );
    // This used to fall out of a creator having no tracked purchases. With no
    // purchase list it has to be an explicit check, or a creator could sell
    // vested allocation into the curve and draw down buyers' principal.
    await expect(submitter.sellTokens('mnemonic', 5n, emptyCapState())).rejects.toThrow(/creator cannot sell/i);
  });

  it('rejects a single sell over the per-transaction cap', async () => {
    const { builder } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x22);
    const { submitter } = makeSubmitter(
      builder,
      [{ datum: baseDatum({ curve_state: 'Active', wallet_cap: 100n, tokens_sold: 500n }), assets: {} }],
      addrFor(sellerHash),
    );
    await expect(submitter.sellTokens('mnemonic', 101n, emptyCapState())).rejects.toThrow(
      /Per-transaction cap exceeded/,
    );
  });

  it("prices at the POST-sell tokens_sold point (symmetric with BuyTokens' pre-buy pricing)", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x22);
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            base_price: 10n,
            max_price: 1010n,
            curve_supply: 1000n,
            tokens_sold: 500n,
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(sellerHash),
    );

    const result = await submitter.sellTokens('mnemonic', 500n, emptyCapState());
    // new_sold = 0, so this vacates positions 0..499 — the same range a buy of
    // 500 from a standing start pays for: 129,750 lovelace, averaging 259.
    expect(result.avgPrice).toBe(259n);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.tokens_sold).toBe(0n);
  });

  it("allows total_raised to go negative (round-trip sell) — no floor, unlike claimBuyback's effectiveTotalRaised", async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x33);
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            base_price: 100n,
            max_price: 100n,
            curve_supply: 1000n,
            tokens_sold: 10n,
            total_raised: 50n, // less than what selling all 10 back will subtract
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(sellerHash),
    );

    await submitter.sellTokens('mnemonic', 10n, emptyCapState());
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    // grossProceeds = price(sold=0)=100 * 10 = 1000; total_raised = 50 - 1000 = -950
    expect(payload.value.total_raised).toBe(-950n);
  });

  it('pays net proceeds to the seller', async () => {
    const { builder, payToAddressCalls, calls } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x44);
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            base_price: 10n,
            max_price: 10n,
            curve_supply: 10000n,
            tokens_sold: 10000n,
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(sellerHash),
    );

    const result = await submitter.sellTokens('mnemonic', 10000n, emptyCapState()); // exact-divisible gross proceeds
    expect(payToAddressCalls).toHaveLength(1);
    const [addr, datum, assets] = payToAddressCalls[0] as [string, InlineDatumArg, Record<string, bigint>];
    expect(addr).toBe(addrFor(sellerHash));
    expect(assets.lovelace).toBe(result.netProceeds);
    // The proceeds name the spend they settle. Without the tag the validator
    // does not see a payout at all, so this is not decoration.
    expect(datum).toEqual(settlesCurveInput(0));

    // The curve's continuing datum carries no per-wallet entry to check: the
    // seller's entitlement was the tokens they handed back, not a stored total.
    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value).not.toHaveProperty('per_address_purchases');
  });
});

// ============================================================================
// expireCurve — permissionless, honest (non-backdatable) validity range
// ============================================================================

describe('LucidTierACurveSubmitter.expireCurve', () => {
  it('rejects when the curve is not Active', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Cancelled' }), assets: {} }]);
    await expect(submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)))).rejects.toThrow(
      /Curve is not Active/,
    );
  });

  it('sets curve_state to Cancelled', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)));
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.curve_state).toBe('Cancelled');
  });

  it('builds a real, honest validity range around the CURRENT time, exactly 480,000ms wide (cap safety margin)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);

    vi.useFakeTimers();
    vi.setSystemTime(1_753_000_000_000);
    await submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)));

    expect(calls.validFrom![0]).toBe(1_753_000_000_000 - 240_000);
    expect(calls.validTo![0]).toBe(1_753_000_000_000 + 240_000);
  });

  it('is permissionless — requires no addSigner call at all', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)));
    expect(calls.addSigner).toBeUndefined();
  });
});

// ============================================================================
// claimBuyback
// ============================================================================

describe('LucidTierACurveSubmitter.claimBuyback', () => {
  it('rejects when the curve is not Cancelled', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await expect(submitter.claimBuyback('mnemonic', 10n)).rejects.toThrow(/Curve is not Cancelled/);
  });

  it('rejects a tokenAmount of 0 or exceeding tokens_sold', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      {
        datum: baseDatum({ curve_state: 'Cancelled', tokens_sold: 10n }),
        assets: {},
      },
    ]);
    await expect(submitter.claimBuyback('mnemonic', 0n)).rejects.toThrow(/token_amount out of range/);
    await expect(submitter.claimBuyback('mnemonic', 11n)).rejects.toThrow(/token_amount out of range/);
  });

  it("floors effectiveTotalRaised at 0 when total_raised is negative (matches the contract's own fix)", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Cancelled',
          tokens_sold: 100n,
          total_raised: -500n,
        }),
        assets: { lovelace: 10_000_000n },
      },
    ]);

    const result = await submitter.claimBuyback('mnemonic', 10n);
    // effectiveTotalRaised floored to 0 -> share = 0 * 10 / 100 = 0, not negative
    expect(result.share).toBe(0n);
  });

  it('computes a real proportional share and pays it to the buyer', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const buyerHash = fakeKeyHash(0x55);
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Cancelled',
            tokens_sold: 100n,
            total_raised: 1000n,
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(buyerHash),
    );

    const result = await submitter.claimBuyback('mnemonic', 25n);
    expect(result.share).toBe(250n); // 1000 * 25 / 100

    const [addr, datum, assets] = payToAddressCalls[0] as [string, InlineDatumArg, Record<string, bigint>];
    expect(addr).toBe(addrFor(buyerHash));
    expect(assets.lovelace).toBe(250n);
    expect(datum).toEqual(settlesCurveInput(0));
  });
});
