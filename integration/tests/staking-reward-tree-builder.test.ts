// A staking position's datum is written by whoever paid the UTXO to the script
// address, and paying a UTXO to a script address runs no validator. So
// `staked_amount` is a claim, not a fact — and rewards accrue by weight.
//
// These pin the one rule that follows: a position weighs what it actually
// holds. Unstake pays out the output's real value, so a false claim costs its
// author nothing to make, which is what makes believing it expensive.

import { Data } from '@lucid-evolution/lucid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStakeHistory } from '../staking-reward-tree-builder.js';
import { type StakingDatumData, StakingDatumSchema } from '../tier-a-schemas.js';

const LAUNCH = 'a1'.repeat(32);
const TOKEN_POLICY = 'b2'.repeat(28);
const TOKEN_NAME = '746f6b';
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_NAME;
const HONEST = '11'.repeat(28);
const LIAR = '22'.repeat(28);
const POOL_TX = 'aa'.repeat(32);
const STAKE_TX = 'bb'.repeat(32);

const CONFIG = { blockfrostUrl: 'https://bf.test', blockfrostProjectId: 'proj' };

function poolDatum() {
  return Data.to<StakingDatumData>(
    {
      Pool: [
        {
          launch_id: LAUNCH,
          governor_pub_key_hash: '33'.repeat(28),
          creator_pub_key_hash: '44'.repeat(28),
          token_policy_id: TOKEN_POLICY,
          token_asset_name: TOKEN_NAME,
          reward_root: '00'.repeat(32),
          claimed_bits: '0000',
          thread_nft_policy: 'c0ffee'.padEnd(56, '0'),
        },
      ],
    },
    StakingDatumSchema as never,
  );
}

function positionDatum(stakerVkh: string, claimedAmount: bigint, tsMs: bigint) {
  return Data.to<StakingDatumData>(
    { Position: [{ launch_id: LAUNCH, staker_vkh: stakerVkh, staked_amount: claimedAmount, stake_timestamp: tsMs }] },
    StakingDatumSchema as never,
  );
}

/** Blockfrost responses, keyed by the path suffix each call uses. */
function mockChain(opts: { positions: Array<{ vkh: string; claimed: bigint; real: bigint }> }) {
  const txs = [
    { tx_hash: POOL_TX, block_time: 1_700_000_000 },
    { tx_hash: STAKE_TX, block_time: 1_700_086_400 },
  ];
  // `inputs` is how the builder closes out a position that was unstaked; none
  // of these scenarios unstakes, so both transactions spend nothing of ours.
  const poolOutputs = {
    inputs: [],
    outputs: [{ output_index: 0, inline_datum: poolDatum(), amount: [{ unit: TOKEN_UNIT, quantity: '1000000' }] }],
  };
  const stakeOutputs = {
    inputs: [],
    outputs: opts.positions.map((p, i) => ({
      output_index: i,
      inline_datum: positionDatum(p.vkh, p.claimed, 1_700_086_400_000n),
      amount: p.real > 0n ? [{ unit: TOKEN_UNIT, quantity: String(p.real) }] : [],
    })),
  };

  const byTx: Record<string, unknown> = { [POOL_TX]: poolOutputs, [STAKE_TX]: stakeOutputs };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      let body: unknown;
      if (url.includes('/transactions')) {
        body = url.includes('page=1') ? txs : [];
      } else {
        const hash = url.split('/txs/')[1]?.split('/')[0] ?? '';
        body = byTx[hash] ?? { inputs: [], outputs: [] };
      }
      return { ok: true, json: async () => body } as never;
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStakeHistory — a position weighs what it holds', () => {
  it('takes the staked amount from the output, not from the datum', async () => {
    mockChain({ positions: [{ vkh: HONEST, claimed: 500n, real: 500n }] });
    const history = await fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]?.stakedAmount).toBe(500n);
  });

  // The whole point. A position claiming a billion while holding one token is
  // free to create, and would otherwise take almost the entire pool.
  it('weighs an inflated claim by what the position really holds', async () => {
    mockChain({ positions: [{ vkh: LIAR, claimed: 1_000_000_000n, real: 1n }] });
    const history = await fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME);
    expect(history.events[0]?.stakedAmount).toBe(1n);
  });

  it('ignores a position holding no tokens at all', async () => {
    mockChain({ positions: [{ vkh: LIAR, claimed: 1_000_000_000n, real: 0n }] });
    const history = await fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME);
    expect(history.events).toHaveLength(0);
  });

  it('leaves an honest position’s weight untouched alongside a lying one', async () => {
    mockChain({
      positions: [
        { vkh: HONEST, claimed: 100n, real: 100n },
        { vkh: LIAR, claimed: 9_999_999n, real: 2n },
      ],
    });
    const history = await fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME);
    const byStaker = Object.fromEntries(history.events.map((e) => [e.stakerVkh, e.stakedAmount]));
    expect(byStaker[HONEST]).toBe(100n);
    expect(byStaker[LIAR]).toBe(2n);
  });
});
