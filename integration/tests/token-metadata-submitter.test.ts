// Tests for token-metadata-submitter.ts's TokenMetadataSubmitter — the
// CIP-68 on-chain-logo feature's Lucid Evolution submitter. Structurally
// different from every other submitter in this codebase: it builds
// UNSIGNED transactions (returns CBOR for a browser wallet to sign) rather
// than signing/submitting server-side, since minting and updating are
// creator/community-wallet actions per this feature's own design (a
// platform key must never sign these). Same importOriginal partial-mock
// Lucid strategy as the other submitter tests, with one addition:
// applyParamsToScript is also stubbed, since it does real UPLC bytecode
// manipulation that needs genuinely valid compiled Plutus script bytes
// (confirmed via a probe: it throws on placeholder CBOR, unlike
// validatorToAddress/mintingPolicyToId, which just hash arbitrary bytes and
// tolerate a placeholder fine — both are kept real here).

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
    applyParamsToScript: vi.fn((script: string) => script),
  };
});

import { applyParamsToScript, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { TokenMetadataSubmitter, toHex } from '../token-metadata-submitter.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-tokmeta-1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
const BONDING_CURVE_HASH = 'bb'.repeat(28);
const CTO_GOVERNANCE_HASH = 'cc'.repeat(28);
const CTO_GOVERNANCE_NFT_POLICY = 'dd'.repeat(28);
const TOKEN_POLICY_ID = 'ee'.repeat(28);
const TOKEN_ASSET_NAME_HEX = toHex(new TextEncoder().encode('tok'));
const CURVE_ADDR = addrFor(fakeKeyHash(0x77));
const CREATOR_ADDR = addrFor(fakeKeyHash(0x11));

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

/** A CIP-68 metadata map as it comes back off chain: hex keys, hex values. */
function metadataMap(name = 'Mock Token'): Map<string, unknown> {
  return new Map<string, unknown>([
    [hex('name'), hex(name)],
    [hex('description'), hex('A mock launch')],
    [hex('decimals'), 0n],
  ]);
}

/**
 * The datum is CIP-68's own shape — constructor 0 over
 * [metadata, version, extra] — so overrides target `extra` unless they name
 * one of the two outer fields.
 */
function metadataDatumFields(extraOverrides: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) {
  return {
    metadata: metadataMap(),
    version: 1n,
    extra: {
      launch_id: LAUNCH_ID_HEX,
      bonding_curve_credential: { ScriptCredential: [BONDING_CURVE_HASH] },
      token_policy_id: TOKEN_POLICY_ID,
      token_asset_name: TOKEN_ASSET_NAME_HEX,
      community_pub_key_hash: '',
      cto_triggered: false,
      cto_governance_credential: { ScriptCredential: [CTO_GOVERNANCE_HASH] },
      thread_nft_policy: CTO_GOVERNANCE_NFT_POLICY,
      metadata_revision: 1n,
      last_updated_ts: 1000n,
      ...extraOverrides,
    },
    ...outer,
  };
}

function makeFakeTxBuilder(cborResult = 'unsigned-cbor-1') {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.readFrom = vi.fn((...a: unknown[]) => {
    calls.readFrom = a;
    return builder;
  });
  builder.mintAssets = vi.fn((...a: unknown[]) => {
    calls.mintAssets = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
    MintingPolicy: vi.fn((...a: unknown[]) => {
      calls.attachMintingPolicy = a;
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
  builder.complete = vi.fn().mockResolvedValue({ toCBOR: () => cborResult });
  return { builder, calls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    metadataUtxos?: Array<{ datum: unknown; assets: Record<string, bigint> }>;
    curveUtxos?: Array<{ datum: unknown; assets: Record<string, bigint> }>;
    creatorUtxos?: Array<{
      txHash: string;
      outputIndex: number;
      assets: Record<string, bigint>;
    }>;
    fromTxResult?: unknown;
  } = {},
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.spend) return Promise.resolve(opts.metadataUtxos ?? []);
      if (address === CURVE_ADDR)
        return Promise.resolve(opts.curveUtxos ?? [{ txHash: 'curve-tx', outputIndex: 0, assets: {} }]);
      if (address === CREATOR_ADDR)
        return Promise.resolve(opts.creatorUtxos ?? [{ txHash: 'aa'.repeat(32), outputIndex: 0, assets: {} }]);
      return Promise.resolve([]);
    }),
    fromTx: vi.fn().mockReturnValue(
      opts.fromTxResult ?? {
        assemble: vi.fn().mockReturnValue({
          complete: vi.fn().mockResolvedValue({
            submit: vi.fn().mockResolvedValue('final-tx-hash-1'),
          }),
        }),
      },
    ),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new TokenMetadataSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    spendScriptCbor: '590000',
    bondingCurveScriptHash: BONDING_CURVE_HASH,
    ctoGovernanceScriptHash: CTO_GOVERNANCE_HASH,
    threadNftPolicyId: CTO_GOVERNANCE_NFT_POLICY,
    tokenPolicyId: TOKEN_POLICY_ID,
    tokenAssetNameHex: TOKEN_ASSET_NAME_HEX,
    launchId: LAUNCH_ID_BYTES,
  });
  addressRefs.spend = (submitter as unknown as { spendAddress: string }).spendAddress;

  return { submitter, fakeLucid };
}

const addressRefs = { spend: '' };

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
  vi.mocked(applyParamsToScript).mockClear();
});

describe('TokenMetadataSubmitter.getCurrentMetadata', () => {
  it('returns null when no token_metadata UTXO exists yet (pre-mint)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, { metadataUtxos: [] });
    await expect(submitter.getCurrentMetadata()).resolves.toBeNull();
  });

  it('returns the real live-decoded state when a metadata UTXO exists, matching the launch_id', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields({ launch_id: 'other-launch' }),
          assets: {},
        },
        {
          datum: metadataDatumFields({
            metadata_revision: 3n,
            cto_triggered: true,
          }),
          assets: {},
        },
      ],
    });

    const result = await submitter.getCurrentMetadata();
    expect(result?.launchId).toBe(LAUNCH_ID_HEX);
    expect(result?.metadataRevision).toBe('3');
    expect(result?.ctoTriggered).toBe(true);
    // The standard's own map comes back as a wallet reads it — hex keys,
    // hex-or-integer values — with nothing dropped.
    expect(result?.metadata[hex('name')]).toBe(hex('Mock Token'));
    expect(result?.metadata[hex('decimals')]).toBe('0');
    expect(result?.standardVersion).toBe('1');
  });
});

describe('TokenMetadataSubmitter.buildUpdateMetadata', () => {
  it('throws when the caller has no UTXOs', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
      creatorUtxos: [],
    });
    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'Anything', description: 'Anything' },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/No UTXOs found at caller address/);
  });

  it('writes the new metadata map, increments the revision, and preserves every field under extra', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields({
            metadata_revision: 4n,
            community_pub_key_hash: fakeKeyHash(0x99),
            cto_triggered: true,
          }),
          assets: { lovelace: 2_000_000n },
        },
      ],
    });

    await submitter.buildUpdateMetadata({
      callerAddress: CREATOR_ADDR,
      curveAddress: CURVE_ADDR,
      newMetadata: { name: 'Renamed', description: 'New copy', ticker: 'TOK', decimals: 0 },
      currentTimestamp: 2_000_000_000,
    });

    const [, payload, assetsArg] = calls.payToContract as [
      string,
      { value: { metadata: Map<string, unknown>; version: bigint; extra: Record<string, unknown> } },
      Record<string, bigint>,
    ];
    expect(payload.value.metadata.get(hex('name'))).toBe(hex('Renamed'));
    expect(payload.value.metadata.get(hex('description'))).toBe(hex('New copy'));
    expect(payload.value.metadata.get(hex('decimals'))).toBe(0n);
    // CIP-68's standard version is not a revision counter and must not move.
    expect(payload.value.version).toBe(1n);
    expect(payload.value.extra.metadata_revision).toBe(5n);
    expect(payload.value.extra.last_updated_ts).toBe(2_000_000_000n);
    expect(payload.value.extra.community_pub_key_hash).toBe(fakeKeyHash(0x99));
    expect(payload.value.extra.cto_triggered).toBe(true);
    expect(payload.value.extra.bonding_curve_credential).toEqual({
      ScriptCredential: [BONDING_CURVE_HASH],
    });
    // The metadata UTXO's own value is re-locked unchanged — the reference
    // NFT stays put, which the validator requires on both sides.
    expect(assetsArg).toEqual({ lovelace: 2_000_000n });
  });

  it('rejects metadata missing a field the 333 sub-standard requires', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
    });

    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'No description', description: '' },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/requires a non-empty description/);
  });

  it('builds the UpdateMetadata redeemer carrying the same map it writes, and reads the curve as a reference input', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
    });

    await submitter.buildUpdateMetadata({
      callerAddress: CREATOR_ADDR,
      curveAddress: CURVE_ADDR,
      newMetadata: { name: 'Redeemed', description: 'Copy' },
      currentTimestamp: 1_800_000_000,
    });

    const redeemer = calls.collectFrom![1] as {
      new_metadata: Map<string, unknown>;
      current_timestamp: bigint;
    };
    // The validator compares the continuing datum against the redeemer, so
    // the two must carry the identical map.
    const [, payload] = calls.payToContract as [string, { value: { metadata: Map<string, unknown> } }];
    expect(redeemer.new_metadata).toEqual(payload.value.metadata);
    expect(redeemer.new_metadata.get(hex('name'))).toBe(hex('Redeemed'));
    expect(redeemer.current_timestamp).toBe(1_800_000_000n);
    expect(calls.readFrom).toBeDefined();
    expect(calls.addSigner).toEqual([CREATOR_ADDR]);
  });
});

describe('TokenMetadataSubmitter.finalizeAndSubmit', () => {
  it('assembles the unsigned tx with the given witness set and submits it', async () => {
    const { builder } = makeFakeTxBuilder();
    const assembleFn = vi.fn().mockReturnValue({
      complete: vi.fn().mockResolvedValue({
        submit: vi.fn().mockResolvedValue('final-tx-hash-2'),
      }),
    });
    const { submitter, fakeLucid } = makeSubmitter(builder, {
      fromTxResult: { assemble: assembleFn },
    });

    const result = await submitter.finalizeAndSubmit('unsigned-cbor-x', 'witness-cbor-y');

    expect(fakeLucid.fromTx).toHaveBeenCalledWith('unsigned-cbor-x');
    expect(assembleFn).toHaveBeenCalledWith(['witness-cbor-y']);
    expect(result.txHash).toBe('final-tx-hash-2');
  });
});
