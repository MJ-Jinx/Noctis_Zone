// Tests for blockfrost-client.ts — the primary Cardano chain-data client.
//
// The case worth pinning hardest is ORDER. Blockfrost defaults to ascending,
// so page 1 of a long-lived address is the OLDEST hundred UTXOs. Reading
// present state that way returns years-old entries and never the current
// ones, and it does so silently — the call succeeds and the data looks real.
// That shape has already produced one real bug here, so `getAddressUtxos`
// asking for the caller's requested order is asserted directly against the
// request URL rather than inferred from the returned rows.
//
// The paginators are the mirror image: they walk oldest-first on purpose,
// because their callers want the whole history (wallet age, counterparty
// scans). Their stop condition — a short page — is asserted too, including
// the boundary where the last page is exactly full.
//
// global.fetch is stubbed per-test; the production module is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockfrostClient, createBlockfrostClient, getChainProvider, MockChainProvider } from '../blockfrost-client.js';

const KEY = 'preprodTESTKEY';

function client(network: 'preview' | 'preprod' | 'mainnet' = 'preprod') {
  // A fresh client per test: the rate limiter keys off the previous request
  // time, so a new instance never sleeps and the suite stays fast.
  return new BlockfrostClient({ apiKey: KEY, network });
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

/**
 * A fetch stub that always answers with `body`. The url and init parameters
 * are declared even though the body ignores them, so the mock's call tuples
 * stay typed and `mock.calls[n][0]` / `[n][1]` are the url and the options.
 */
const respond = (body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => ok(body));

/**
 * Returns each queued response in turn — for the paginating methods. The url
 * parameter is declared even though it is unused, so the mock's call tuples
 * stay typed and `mock.calls[n][0]` is the requested url.
 */
function queue(...bodies: unknown[]) {
  let i = 0;
  return vi.fn(async (_url: string) => ok(bodies[i++] ?? []));
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: `tx${i}` }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('request routing', () => {
  it('sends the api key as project_id', async () => {
    const f = respond({ height: 1 });
    vi.stubGlobal('fetch', f);

    await client().getLatestBlock();

    expect(f.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ project_id: KEY }) });
  });

  it.each([
    ['preprod', 'https://cardano-preprod.blockfrost.io/api/v0'],
    ['preview', 'https://cardano-preview.blockfrost.io/api/v0'],
    ['mainnet', 'https://cardano.blockfrost.io/api/v0'],
  ] as const)('targets the %s base url', async (network, base) => {
    const f = respond({ height: 1 });
    vi.stubGlobal('fetch', f);

    await client(network).getLatestBlock();

    expect(f.mock.calls[0][0]).toBe(`${base}/blocks/latest`);
  });

  it('falls back to preprod for an unrecognised network', async () => {
    const f = respond({ height: 1 });
    vi.stubGlobal('fetch', f);

    await new BlockfrostClient({ apiKey: KEY, network: 'nonsense' as never }).getLatestBlock();

    expect(f.mock.calls[0][0]).toContain('cardano-preprod');
  });
});

describe('getAddressUtxos order', () => {
  it('defaults to ascending — the oldest page', async () => {
    const f = respond([]);
    vi.stubGlobal('fetch', f);

    await client().getAddressUtxos('addr_test1x');

    expect(f.mock.calls[0][0]).toContain('/addresses/addr_test1x/utxos?order=asc');
  });

  it('asks for descending when the caller wants present state', async () => {
    // This is the call shape anything reading CURRENT state must use. A
    // regression here reintroduces a bug that returns stale UTXOs silently.
    const f = respond([]);
    vi.stubGlobal('fetch', f);

    await client().getAddressUtxos('addr_test1x', 'desc');

    expect(f.mock.calls[0][0]).toContain('order=desc');
    expect(f.mock.calls[0][0]).not.toContain('order=asc');
  });
});

describe('pagination', () => {
  it('stops on the first short page', async () => {
    const f = queue(rows(100), rows(42));
    vi.stubGlobal('fetch', f);

    const all = await client().getAddressTransactionsAll('addr1');

    expect(all).toHaveLength(142);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][0]).toContain('page=1');
    expect(f.mock.calls[1][0]).toContain('page=2');
  });

  it('asks for one more page when the last one is exactly full', async () => {
    // The boundary: a full page cannot be assumed to be the end, so the
    // walker must probe once more and get an empty page back.
    const f = queue(rows(100), rows(100), []);
    vi.stubGlobal('fetch', f);

    const all = await client().getAddressTransactionsAll('addr1');

    expect(all).toHaveLength(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('returns nothing for an address with no history', async () => {
    vi.stubGlobal('fetch', queue([]));

    expect(await client().getAddressTransactionsAll('addr1')).toEqual([]);
  });

  it('walks transaction history oldest-first, which is what wallet age needs', async () => {
    const f = queue([]);
    vi.stubGlobal('fetch', f);

    await client().getAddressTransactionsAll('addr1');

    expect(f.mock.calls[0][0]).toContain('order=asc');
    expect(f.mock.calls[0][0]).toContain('count=100');
  });

  it('paginates asset holders the same way', async () => {
    const f = queue(rows(100), rows(1));
    vi.stubGlobal('fetch', f);

    const holders = await client().getAssetAddresses('assetid');

    expect(holders).toHaveLength(101);
    expect(f.mock.calls[1][0]).toContain('/assets/assetid/addresses?page=2');
  });

  it('paginates all UTXOs at an address', async () => {
    const f = queue(rows(100), rows(3));
    vi.stubGlobal('fetch', f);

    expect(await client().getAddressUtxosAll('addr1')).toHaveLength(103);
  });
});

describe('error handling and retry', () => {
  it('surfaces the status and body of a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' })),
    );

    await expect(client().getLatestBlock()).rejects.toThrow('Blockfrost API error 404: not found');
  });

  it('retries a 429 and returns the retry’s result', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        return n === 1 ? { ok: false, status: 429, json: async () => ({}), text: async () => '' } : ok({ height: 7 });
      }),
    );

    const p = client().getLatestBlock();
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ height: 7 });
    expect(n).toBe(2);
  });

  it('gives up on a 429 after exhausting its retries', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', f);

    const p = client().getLatestBlock();
    // Attach the rejection handler before advancing, or the rejection is
    // unhandled at the moment the timers flush.
    const assertion = expect(p).rejects.toThrow('Blockfrost rate limit exceeded');
    await vi.runAllTimersAsync();
    await assertion;

    // The initial attempt plus MAX_RETRIES.
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('retries a network error, which arrives as a TypeError', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        if (n === 1) throw new TypeError('fetch failed');
        return ok({ height: 9 });
      }),
    );

    const p = client().getLatestBlock();
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ height: 9 });
  });

  it('does not retry an error that is not a network error', async () => {
    const f = vi.fn(async () => {
      throw new RangeError('bad');
    });
    vi.stubGlobal('fetch', f);

    await expect(client().getLatestBlock()).rejects.toThrow(RangeError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('createBlockfrostClient', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.BLOCKFROST_API_KEY;
    delete process.env.BLOCKFROST_NETWORK;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses to build without an api key', () => {
    expect(() => createBlockfrostClient()).toThrow(/BLOCKFROST_API_KEY/);
  });

  it('defaults to preprod', async () => {
    process.env.BLOCKFROST_API_KEY = KEY;
    const f = respond({ height: 1 });
    vi.stubGlobal('fetch', f);

    await createBlockfrostClient().getLatestBlock();

    expect(f.mock.calls[0][0]).toContain('cardano-preprod');
  });

  it('honours BLOCKFROST_NETWORK', async () => {
    process.env.BLOCKFROST_API_KEY = KEY;
    process.env.BLOCKFROST_NETWORK = 'mainnet';
    const f = respond({ height: 1 });
    vi.stubGlobal('fetch', f);

    await createBlockfrostClient().getLatestBlock();

    expect(f.mock.calls[0][0]).toBe('https://cardano.blockfrost.io/api/v0/blocks/latest');
  });

  it('returns the mock provider in demoLand mode, and never asks for a key', () => {
    process.env.NOCTIS_MODE = 'demoLand';
    try {
      expect(getChainProvider()).toBeInstanceOf(MockChainProvider);
    } finally {
      delete process.env.NOCTIS_MODE;
    }
  });

  it('returns a real client outside demo mode', () => {
    process.env.BLOCKFROST_API_KEY = KEY;
    delete process.env.NOCTIS_MODE;

    expect(getChainProvider()).toBeInstanceOf(BlockfrostClient);
  });
});
