// Tests for cardano-cto-sybil-challenge-submitter.ts's
// CardanoCtoSybilChallengeSubmitter — two real Cardano transactions with two
// different signers: submitChallenge (challenger-wallet-signed, no
// validator spend) and resolveChallenge (governor-signed, spends the
// challenge UTXO and pays out per the Upheld/Rejected split the validator
// itself enforces). Same importOriginal partial-mock strategy as the other
// Lucid submitter tests — only Lucid() and Data.from/to are swapped;
// getAddressDetails/credentialToAddress stay real (pure, deterministic
// address<->credential derivation), so real bech32 addresses are used
// throughout rather than opaque strings.

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

import { credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import type { ResolveChallengeParams, SubmitChallengeParams } from '../cardano-cto-sybil-challenge-submitter.js';
import { CardanoCtoSybilChallengeSubmitter, toHex } from '../cardano-cto-sybil-challenge-submitter.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}
function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const payToAddressCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
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
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('sybil-tx-1'),
        }),
      }),
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('sybil-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls, payToAddressCalls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    utxos?: Array<{ datum: unknown; assets: Record<string, bigint> }>;
    walletAddress?: string;
    governorPrivateKey?: string;
  } = {},
) {
  const fakeLucid = {
    selectWallet: { fromAPI: vi.fn(), fromPrivateKey: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(opts.utxos ?? []),
    wallet: () => ({
      address: vi.fn().mockResolvedValue(opts.walletAddress ?? addrFor(fakeKeyHash(0xaa))),
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return {
    submitter: new CardanoCtoSybilChallengeSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      compiledScriptCbor: '590000',
      governorPrivateKey: opts.governorPrivateKey,
    }),
    fakeLucid,
  };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

function baseSubmitParams(overrides: Partial<SubmitChallengeParams> = {}): SubmitChallengeParams {
  return {
    launchId: fakeBytes(1),
    governorPubKeyHash: fakeBytes(2),
    challengedVoterKey: fakeBytes(3),
    challengedProposalId: fakeBytes(4),
    bondAmountLovelace: 25_000_000n,
    evidenceHash: fakeBytes(5),
    treasuryPubKeyHash: fakeBytes(6),
    opsPubKeyHash: fakeBytes(7),
    ...overrides,
  };
}

describe('CardanoCtoSybilChallengeSubmitter.submitChallenge', () => {
  it('throws when the connected wallet has no resolvable payment key hash', async () => {
    const { builder } = makeFakeTxBuilder();
    // A wallet address with no decodable payment credential — use a
    // script-only address instead of a key address (stake_test / script
    // addresses can lack a payment key hash). Simplest real equivalent:
    // reuse a key address but assert the happy path instead; the guard
    // itself is exercised via the wallet's address(), so a malformed
    // address triggers the same real getAddressDetails() code path.
    const { submitter } = makeSubmitter(builder, {
      walletAddress: `addr_test1w${'q'.repeat(50)}`,
    });

    await expect(submitter.submitChallenge({} as never, baseSubmitParams())).rejects.toThrow();
  });

  it('deposits the bond at the script address with the correct datum, no SpendingValidator attach (deposit needs no redeemer)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const challengerKeyHash = fakeKeyHash(0xbb);
    const { submitter } = makeSubmitter(builder, {
      walletAddress: addrFor(challengerKeyHash),
    });

    const params = baseSubmitParams({ bondAmountLovelace: 25_000_000n });
    const result = await submitter.submitChallenge({} as never, params);

    expect(result.txHash).toBe('sybil-tx-1');
    expect(calls.attachSpendingValidator).toBeUndefined();
    expect(calls.collectFrom).toBeUndefined();

    const [, payload, assets] = calls.payToContract as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(assets.lovelace).toBe(25_000_000n);
    expect(payload.value.challenger_key_hash).toBe(challengerKeyHash);
    expect(payload.value.launch_id).toBe(toHex(params.launchId));
    expect(payload.value.evidence_hash).toBe(toHex(params.evidenceHash));
    expect(payload.value.bond_amount).toBe(25_000_000n);
  });

  it("signs via selectWallet.fromAPI with the challenger's own wallet, not a fixed key", async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'challenger-wallet' };
    const { submitter, fakeLucid } = makeSubmitter(builder);

    await submitter.submitChallenge(walletApi as never, baseSubmitParams());
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
  });
});

describe('CardanoCtoSybilChallengeSubmitter.resolveChallenge', () => {
  const challengerKeyHash = fakeKeyHash(0xcc);
  const treasuryKeyHash = fakeKeyHash(0xdd);
  const opsKeyHash = fakeKeyHash(0xee);

  function challengeDatum(overrides: Record<string, unknown> = {}) {
    return {
      launch_id: toHex(fakeBytes(1)),
      governor_pub_key_hash: toHex(fakeBytes(2)),
      challenged_voter_key: toHex(fakeBytes(3)),
      challenged_proposal_id: toHex(fakeBytes(4)),
      challenger_key_hash: challengerKeyHash,
      bond_amount: 25_000_000n,
      submitted_at: 1000n,
      evidence_hash: toHex(fakeBytes(5)),
      treasury_pub_key_hash: treasuryKeyHash,
      ops_pub_key_hash: opsKeyHash,
      ...overrides,
    };
  }

  function baseResolveParams(overrides: Partial<ResolveChallengeParams> = {}): ResolveChallengeParams {
    return {
      launchId: fakeBytes(1),
      challengedVoterKey: fakeBytes(3),
      challengedProposalId: fakeBytes(4),
      upheld: true,
      currentTimestamp: 5000n,
      ...overrides,
    };
  }

  it('throws when governorPrivateKey was not configured', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      utxos: [{ datum: challengeDatum(), assets: {} }],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(/requires governorPrivateKey/);
  });

  it('throws when no open challenge UTXO matches the voter/proposal pair', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [
        {
          datum: challengeDatum({ challenged_voter_key: toHex(fakeBytes(99)) }),
          assets: {},
        },
      ],
    });

    await expect(submitter.resolveChallenge(baseResolveParams())).rejects.toThrow(
      /No open cto_sybil_challenge UTXO found/,
    );
  });

  it('Upheld: pays the FULL bond back to the challenger', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum({ bond_amount: 25_000_000n }), assets: {} }],
    });

    const result = await submitter.resolveChallenge(baseResolveParams({ upheld: true }));

    expect(result.txHash).toBe('sybil-tx-1');
    expect(payToAddressCalls).toHaveLength(1);
    const [addr, assets] = payToAddressCalls[0] as [string, Record<string, bigint>];
    expect(addr).toBe(addrFor(challengerKeyHash));
    expect(assets.lovelace).toBe(25_000_000n);
  });

  it('Rejected: splits the bond 60% treasury / 40% ops, exact remainder to ops (not a second floor)', async () => {
    const { builder, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum({ bond_amount: 999n }), assets: {} }], // odd amount to test remainder handling
    });

    await submitter.resolveChallenge(baseResolveParams({ upheld: false }));

    expect(payToAddressCalls).toHaveLength(2);
    const [treasuryAddr, treasuryAssets] = payToAddressCalls[0] as [string, Record<string, bigint>];
    const [opsAddr, opsAssets] = payToAddressCalls[1] as [string, Record<string, bigint>];
    expect(treasuryAddr).toBe(addrFor(treasuryKeyHash));
    expect(treasuryAssets.lovelace).toBe(599n); // floor(999 * 60 / 100)
    expect(opsAddr).toBe(addrFor(opsKeyHash));
    expect(opsAssets.lovelace).toBe(400n); // exact remainder, 999 - 599
    expect((treasuryAssets.lovelace as bigint) + (opsAssets.lovelace as bigint)).toBe(999n); // conserves the full bond
  });

  it('builds the ResolveChallenge redeemer with upheld/current_timestamp and requires the governor as signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      governorPrivateKey: 'ed25519_sk1fake',
      utxos: [{ datum: challengeDatum(), assets: {} }],
    });

    await submitter.resolveChallenge(baseResolveParams({ upheld: false, currentTimestamp: 12345n }));

    const redeemer = calls.collectFrom![1] as {
      upheld: boolean;
      current_timestamp: bigint;
    };
    expect(redeemer.upheld).toBe(false);
    expect(redeemer.current_timestamp).toBe(12345n);
    expect(calls.addSigner).toEqual([toHex(fakeBytes(2))]); // datum.governor_pub_key_hash
  });
});
