// Every validator is unparameterized, so one script address holds every
// launch's UTXO of that kind and anyone can add another. These cover the two
// things that makes necessary: authenticate by the thread NFT rather than by a
// datum's own claim, and refuse rather than choose when two UTXOs both answer.

import { describe, expect, it, vi } from 'vitest';

import { selectLaunchUtxo } from '../launch-utxo-lookup.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

// Only `Data.from` is replaced — the fixtures below are already decoded, and a
// real CBOR decode is not what these tests are about. The rest of the module
// has to stay real, because tier-a-schemas builds its shapes out of Data.Object
// and friends the moment it is imported.
vi.mock('@lucid-evolution/lucid', async () => {
  const actual = await vi.importActual<typeof import('@lucid-evolution/lucid')>('@lucid-evolution/lucid');
  return { ...actual, Data: { ...actual.Data, from: (datum: unknown) => datum } };
});

const LAUNCH = 'a1'.repeat(32);
const OTHER_LAUNCH = 'b2'.repeat(32);
const POLICY = 'c0ffee'.padEnd(56, '0');
const FORGER_POLICY = 'dead'.padEnd(56, '0');
const ADDRESS = 'addr_test1shared';

const unitFor = (policy: string, launch: string) => policy + threadNftAssetName('bondingCurve', launch);

function utxo(opts: {
  launch?: string;
  policy?: string;
  assets?: Record<string, bigint>;
  ref?: string;
  datum?: unknown;
}) {
  const launch = opts.launch ?? LAUNCH;
  const policy = opts.policy ?? POLICY;
  return {
    txHash: opts.ref ?? '00'.repeat(32),
    outputIndex: 0,
    address: ADDRESS,
    assets: opts.assets ?? { [unitFor(policy, launch)]: 1n },
    // `in` rather than `??`, so a test can hand over an explicitly absent
    // datum without it being read as "not specified" and replaced.
    datum: 'datum' in opts ? opts.datum : { launch_id: launch, thread_nft_policy: policy },
  } as never;
}

const find = (utxos: unknown[]) =>
  selectLaunchUtxo<{ launch_id: string; thread_nft_policy: string }>(
    utxos as never,
    ADDRESS,
    LAUNCH,
    'bondingCurve',
    {},
  );

describe('selectLaunchUtxo', () => {
  it('returns the launch’s own UTXO', () => {
    const found = find([utxo({ launch: OTHER_LAUNCH }), utxo({})]);
    expect(found.datum.launch_id).toBe(LAUNCH);
  });

  it('ignores a UTXO that claims the launch but carries no thread NFT', () => {
    // The datum alone is a claim, not evidence: anyone may pay a datum of any
    // shape to a shared script address.
    expect(() => find([utxo({ assets: {} })])).toThrow(/carries launch/);
  });

  it('ignores a thread NFT minted for a different role', () => {
    const wrongRole = POLICY + threadNftAssetName('vesting', LAUNCH);
    expect(() => find([utxo({ assets: { [wrongRole]: 1n } })])).toThrow(/carries launch/);
  });

  it('ignores another launch’s UTXO at the same address', () => {
    expect(() => find([utxo({ launch: OTHER_LAUNCH })])).toThrow(/carries launch/);
  });

  // The one that matters. A forger can mint under their own policy and satisfy
  // the token check, so the lookup must not pick a winner — it has to stop.
  it('refuses to choose when a second UTXO also answers to the launch', () => {
    const genuine = utxo({ ref: '11'.repeat(32) });
    const planted = utxo({ ref: '22'.repeat(32), policy: FORGER_POLICY });
    expect(() => find([genuine, planted])).toThrow(/Refusing to guess/);
  });

  it('names both candidates so the ambiguity can be investigated', () => {
    const genuine = utxo({ ref: '11'.repeat(32) });
    const planted = utxo({ ref: '22'.repeat(32), policy: FORGER_POLICY });
    expect(() => find([genuine, planted])).toThrow(new RegExp(`${'11'.repeat(32)}#0.*${'22'.repeat(32)}#0`));
  });

  it('skips a UTXO with no datum at all', () => {
    expect(() => find([utxo({ datum: null })])).toThrow(/carries launch/);
  });
});
