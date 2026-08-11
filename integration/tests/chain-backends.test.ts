// Tests for chain-backends.ts — the Blockfrost and Koios providers behind
// ChainProviderRouter.
//
// WHY THIS MATTERS
// The router's whole promise is that a caller cannot tell which backend
// answered. The router itself is tested; its backends were not, and the
// backends are where that promise is actually kept or broken — two providers,
// two response shapes, two sets of numeric types, one normalised output.
//
// A backend that returns a subtly different shape does not fail. It answers,
// and the difference shows up somewhere else entirely: a UTxO with a missing
// asset, an address that looks unused, a wallet whose age is wrong.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockfrostClient } from '../blockfrost-client.js';
import { BlockfrostBackend, KoiosBackend } from '../chain-backends.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// BLOCKFROST
// ============================================================================

describe('BlockfrostBackend', () => {
  function backendWith(client: Partial<BlockfrostClient>) {
    return new BlockfrostBackend(client as BlockfrostClient);
  }

  it('declares no unsupported methods', () => {
    expect(backendWith({}).unsupportedMethods.size).toBe(0);
    expect(backendWith({}).name).toBe('blockfrost');
  });

  it('renames the tip fields without moving their values', async () => {
    const backend = backendWith({
      getLatestBlock: vi.fn(async () => ({ height: 11, epoch: 22, slot: 33, hash: 'abc' })) as never,
    });
    await expect(backend.getLatestBlock()).resolves.toEqual({ height: 11, epoch: 22, slot: 33, hash: 'abc' });
  });

  it('passes a null stake address through rather than dropping the field', async () => {
    // An enterprise address genuinely has no stake credential, and eligibility
    // check #4 distinguishes that from "not read". Losing the key here turns
    // one into the other.
    const backend = backendWith({
      getAddress: vi.fn(async () => ({ address: 'addr1', stake_address: null, type: 'shelley' })) as never,
    });
    const info = await backend.getAddressInfo('addr1');
    expect(info).toEqual({ address: 'addr1', stakeAddress: null });
    expect('stakeAddress' in info).toBe(true);
  });

  it('uses output_index, not tx_index, for a UTxO reference', async () => {
    // Blockfrost exposes both and they are not the same number. A UTxO ref
    // built from the wrong one points at a different output of the same
    // transaction, which resolves and spends the wrong value.
    const backend = backendWith({
      getAddressUtxosAll: vi.fn(async () => [
        { tx_hash: 'h1', tx_index: 7, output_index: 2, amount: [{ unit: 'lovelace', quantity: '5' }] },
      ]) as never,
    });
    await expect(backend.getAddressUtxosAll('addr1')).resolves.toEqual([
      { txHash: 'h1', outputIndex: 2, amount: [{ unit: 'lovelace', quantity: '5' }] },
    ]);
  });

  it('returns transactions oldest first even when the client does not', async () => {
    // The client asks for order=asc, so this is normally already true. It is
    // enforced here anyway because a caller reads index 0 as the address's
    // first-ever transaction, and that must not depend on a query string in
    // another file staying the way it is.
    const backend = backendWith({
      getAddressTransactionsAll: vi.fn(async () => [
        { tx_hash: 'newest', tx_index: 0, block_height: 300, block_time: 3000 },
        { tx_hash: 'oldest', tx_index: 0, block_height: 100, block_time: 1000 },
        { tx_hash: 'middle', tx_index: 0, block_height: 200, block_time: 2000 },
      ]) as never,
    });
    const txs = await backend.getAddressTransactionsAll('addr1');
    expect(txs.map((t) => t.txHash)).toEqual(['oldest', 'middle', 'newest']);
  });
});

// ============================================================================
// KOIOS
// ============================================================================

interface StubbedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Serves one queued response per call and records what was asked for. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
  const calls: StubbedCall[] = [];
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const spec = responses[Math.min(index, responses.length - 1)];
      index += 1;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return {
        ok: spec.ok ?? true,
        status: spec.status ?? 200,
        json: async () => spec.json,
        text: async () => spec.text ?? '',
      };
    }),
  );
  return calls;
}

describe('KoiosBackend', () => {
  it('picks the base URL for the network it was given', async () => {
    const calls = stubFetch([{ json: [{ hash: 'h', block_no: 1, abs_slot: 2, epoch_no: 3 }] }]);
    await new KoiosBackend('mainnet').getLatestBlock();
    expect(calls[0].url).toBe('https://api.koios.rest/api/v1/tip');
  });

  it('prefers an explicit base URL over the network default', async () => {
    const calls = stubFetch([{ json: [{ hash: 'h', block_no: 1, abs_slot: 2, epoch_no: 3 }] }]);
    await new KoiosBackend('mainnet', 'http://localhost:9999/api/v1').getLatestBlock();
    expect(calls[0].url).toBe('http://localhost:9999/api/v1/tip');
  });

  it('maps block_no to height and abs_slot to slot', async () => {
    // Koios names these differently from Blockfrost, and `block_no` and
    // `abs_slot` are both plausible-looking integers — swapping them produces
    // a tip that is wrong by a factor of about twenty and still parses.
    stubFetch([{ json: [{ hash: 'tiphash', block_no: 1_234, abs_slot: 98_765, epoch_no: 42 }] }]);
    await expect(new KoiosBackend('preprod').getLatestBlock()).resolves.toEqual({
      height: 1_234,
      epoch: 42,
      slot: 98_765,
      hash: 'tiphash',
    });
  });

  it('throws when /tip returns no rows', async () => {
    stubFetch([{ json: [] }]);
    await expect(new KoiosBackend('preprod').getLatestBlock()).rejects.toThrow(/no rows/);
  });

  it('throws with the status when a request is not ok', async () => {
    stubFetch([{ ok: false, status: 503, text: 'upstream unavailable' }]);
    await expect(new KoiosBackend('preprod').getLatestBlock()).rejects.toThrow(/503/);
  });

  it('treats an address with no history as a real answer, not a failure', async () => {
    // Returning zero rows must not throw. A throw here would trip the
    // router's circuit breaker and take Koios out of service for every other
    // address, over an address that is simply unused.
    stubFetch([{ json: [] }]);
    await expect(new KoiosBackend('preprod').getAddressInfo('addr_unused')).resolves.toEqual({
      address: 'addr_unused',
      stakeAddress: null,
    });
  });

  it('posts the address in the body Koios expects', async () => {
    const calls = stubFetch([{ json: [{ address: 'addr1', stake_address: 'stake1' }] }]);
    await new KoiosBackend('preprod').getAddressInfo('addr1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ _addresses: ['addr1'] });
  });

  it('normalises a missing stake_address to null', async () => {
    stubFetch([{ json: [{ address: 'addr1' }] }]);
    await expect(new KoiosBackend('preprod').getAddressInfo('addr1')).resolves.toEqual({
      address: 'addr1',
      stakeAddress: null,
    });
  });

  it('rebuilds a Blockfrost-style asset unit from Koios split fields', async () => {
    // Blockfrost's `unit` is policyId ++ hex(assetName) as one string; Koios
    // returns the two separately. Everything downstream matches on the joined
    // form, so a backend that returned only the policy id would look like a
    // different asset.
    stubFetch([
      {
        json: [
          {
            tx_hash: 'h1',
            tx_index: 3,
            value: '2000000',
            asset_list: [{ policy_id: 'aa'.repeat(28), asset_name: '4e4f43', quantity: '5' }],
          },
        ],
      },
    ]);
    const utxos = await new KoiosBackend('preprod').getAddressUtxosAll('addr1');
    expect(utxos).toEqual([
      {
        txHash: 'h1',
        outputIndex: 3,
        amount: [
          { unit: 'lovelace', quantity: '2000000' },
          { unit: `${'aa'.repeat(28)}4e4f43`, quantity: '5' },
        ],
      },
    ]);
  });

  it('handles a UTxO with no assets and a string tx_index', async () => {
    // Koios types some numerics as strings depending on endpoint, and
    // asset_list is absent rather than empty when there are none.
    stubFetch([{ json: [{ tx_hash: 'h1', tx_index: '11', value: '1000000' }] }]);
    const [utxo] = await new KoiosBackend('preprod').getAddressUtxosAll('addr1');
    expect(utxo.outputIndex).toBe(11);
    expect(utxo.amount).toEqual([{ unit: 'lovelace', quantity: '1000000' }]);
  });

  it('keeps paging while a full page comes back', async () => {
    // A short page is the only stop signal. Stopping after the first page
    // instead would silently truncate a large wallet to its first 1000 UTxOs,
    // and every balance computed from it would be wrong but plausible.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      tx_hash: `h${i}`,
      tx_index: 0,
      value: '1',
    }));
    const calls = stubFetch([{ json: fullPage }, { json: [{ tx_hash: 'last', tx_index: 0, value: '1' }] }]);
    const utxos = await new KoiosBackend('preprod').getAddressUtxosAll('addr1');
    expect(utxos).toHaveLength(1001);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('offset=0');
    expect(calls[1].url).toContain('offset=1000');
  });

  it('stops after a single short page', async () => {
    const calls = stubFetch([{ json: [{ tx_hash: 'h1', tx_index: 0, value: '1' }] }]);
    await new KoiosBackend('preprod').getAddressUtxosAll('addr1');
    expect(calls).toHaveLength(1);
  });

  it('converts string block heights and times to numbers', async () => {
    stubFetch([{ json: [{ tx_hash: 'h1', block_height: '900', block_time: '1700000000' }] }]);
    const [tx] = await new KoiosBackend('preprod').getAddressTransactionsAll('addr1');
    expect(tx).toEqual({ txHash: 'h1', blockHeight: 900, blockTime: 1_700_000_000 });
  });

  it('returns transactions oldest first', async () => {
    // Koios does not sort, and nothing in its response says so. Wallet age is
    // read from index 0, so an unsorted list makes an old wallet as young as
    // its most recent activity — which every active wallet passes.
    stubFetch([
      {
        json: [
          { tx_hash: 'newest', block_height: 300, block_time: 3000 },
          { tx_hash: 'oldest', block_height: 100, block_time: 1000 },
          { tx_hash: 'middle', block_height: 200, block_time: 2000 },
        ],
      },
    ]);
    const txs = await new KoiosBackend('preprod').getAddressTransactionsAll('addr1');
    expect(txs.map((t) => t.txHash)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('orders two transactions from the same block by height, keeping ties stable', async () => {
    stubFetch([
      {
        json: [
          { tx_hash: 'second', block_height: 101, block_time: 1000 },
          { tx_hash: 'first', block_height: 100, block_time: 1000 },
          { tx_hash: 'tie-a', block_height: 100, block_time: 1000 },
        ],
      },
    ]);
    const txs = await new KoiosBackend('preprod').getAddressTransactionsAll('addr1');
    expect(txs.map((t) => t.txHash)).toEqual(['first', 'tie-a', 'second']);
  });

  it('is marked laggy so the router de-prioritises it for historical reads', () => {
    expect(new KoiosBackend('preprod').laggy).toBe(true);
    expect(new KoiosBackend('preprod').unsupportedMethods.size).toBe(0);
  });
});
