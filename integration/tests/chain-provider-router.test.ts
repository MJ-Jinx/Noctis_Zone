// Tests for chain-provider-router.ts — the multi-provider failover layer.
//
// All backends here are in-memory fakes; nothing touches the network. The
// behaviours under test are the ones that are easy to get subtly wrong:
//   - an UNSUPPORTED method must not count against a backend's circuit breaker
//     (the borrowed ODATANO insight — otherwise a method-shaped gap looks like
//     an outage and takes the provider out for calls it could have served)
//   - a laggy backend is de-prioritised for historical reads but still used
//     first-class for live ones
//   - identical in-flight requests are coalesced into one upstream call

import { describe, expect, it, vi } from 'vitest';

import {
  AllBackendsFailedError,
  type ChainBackend,
  type ChainMethod,
  ChainProviderRouter,
  CircuitBreakerManager,
  RequestCoalescer,
  type RouterAddressInfo,
  type RouterAddressTransaction,
  type RouterAddressUtxo,
  type RouterBlockInfo,
} from '../chain-provider-router.js';

// ---------------------------------------------------------------------------
// Fake backend
// ---------------------------------------------------------------------------

interface FakeOptions {
  name: string;
  unsupported?: ChainMethod[];
  laggy?: boolean;
  /** Throw on every call. */
  failing?: boolean;
  /** Delay each call by this many ms (for timeout tests). */
  delayMs?: number;
}

class FakeBackend implements ChainBackend {
  readonly name: string;
  readonly unsupportedMethods: ReadonlySet<ChainMethod>;
  readonly laggy?: boolean;
  readonly calls: ChainMethod[] = [];
  private readonly failing: boolean;
  private readonly delayMs: number;

  constructor(o: FakeOptions) {
    this.name = o.name;
    this.unsupportedMethods = new Set(o.unsupported ?? []);
    this.laggy = o.laggy;
    this.failing = o.failing ?? false;
    this.delayMs = o.delayMs ?? 0;
  }

  private async guard<T>(method: ChainMethod, value: T): Promise<T> {
    this.calls.push(method);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failing) throw new Error(`${this.name} is down`);
    return value;
  }

  getLatestBlock(): Promise<RouterBlockInfo> {
    return this.guard('getLatestBlock', {
      height: 1,
      epoch: 2,
      slot: 3,
      hash: `hash-${this.name}`,
    });
  }

  getAddressInfo(address: string): Promise<RouterAddressInfo> {
    return this.guard('getAddressInfo', { address, stakeAddress: `stake-${this.name}` });
  }

  getAddressUtxosAll(_address: string): Promise<RouterAddressUtxo[]> {
    return this.guard('getAddressUtxosAll', [
      { txHash: `tx-${this.name}`, outputIndex: 0, amount: [{ unit: 'lovelace', quantity: '1' }] },
    ]);
  }

  getAddressTransactionsAll(_address: string): Promise<RouterAddressTransaction[]> {
    return this.guard('getAddressTransactionsAll', [{ txHash: `tx-${this.name}`, blockHeight: 1, blockTime: 2 }]);
  }
}

// ---------------------------------------------------------------------------

describe('ChainProviderRouter — routing and failover', () => {
  it('uses the first backend when it succeeds', async () => {
    const a = new FakeBackend({ name: 'a' });
    const b = new FakeBackend({ name: 'b' });
    const router = new ChainProviderRouter([a, b]);

    const block = await router.getLatestBlock();

    expect(block.hash).toBe('hash-a');
    expect(b.calls).toHaveLength(0);
  });

  it('falls over to the next backend when the first throws', async () => {
    const a = new FakeBackend({ name: 'a', failing: true });
    const b = new FakeBackend({ name: 'b' });
    const router = new ChainProviderRouter([a, b]);

    const block = await router.getLatestBlock();

    expect(block.hash).toBe('hash-b');
    expect(a.calls).toEqual(['getLatestBlock']);
  });

  it('throws AllBackendsFailedError listing every attempt when all fail', async () => {
    const a = new FakeBackend({ name: 'a', failing: true });
    const b = new FakeBackend({ name: 'b', failing: true });
    const router = new ChainProviderRouter([a, b]);

    await expect(router.getLatestBlock()).rejects.toBeInstanceOf(AllBackendsFailedError);

    await expect(router.getLatestBlock()).rejects.toThrow(/a is down/);
  });

  it('rejects construction with no backends', () => {
    expect(() => new ChainProviderRouter([])).toThrow(/at least one backend/);
  });
});

describe('ChainProviderRouter — unsupported methods do not poison the breaker', () => {
  it('skips an unsupported method without calling the backend', async () => {
    const limited = new FakeBackend({ name: 'limited', unsupported: ['getAddressTransactionsAll'] });
    const full = new FakeBackend({ name: 'full' });
    const router = new ChainProviderRouter([limited, full]);

    const txs = await router.getAddressTransactionsAll('addr1');

    expect(txs[0]?.txHash).toBe('tx-full');
    expect(limited.calls).toHaveLength(0);
  });

  it('leaves the breaker CLOSED after an unsupported skip, so other methods still route to it first', async () => {
    // This is the whole point of `unsupportedMethods`. If an unsupported call
    // were treated as a failure, repeated calls would open the breaker and the
    // backend would stop being tried for methods it serves perfectly well.
    const limited = new FakeBackend({ name: 'limited', unsupported: ['getAddressTransactionsAll'] });
    const full = new FakeBackend({ name: 'full' });
    const router = new ChainProviderRouter([limited, full], {
      breaker: { failureThreshold: 2, resetTimeoutMs: 1000 },
    });

    // Enough unsupported calls to trip a 2-failure breaker, if they counted.
    await router.getAddressTransactionsAll('addr1');
    await router.getAddressTransactionsAll('addr2');
    await router.getAddressTransactionsAll('addr3');

    expect(router.health()).toContainEqual({ backend: 'limited', circuit: 'closed' });

    // A method it DOES support must still go to it first.
    const block = await router.getLatestBlock();
    expect(block.hash).toBe('hash-limited');
  });

  it('reports unsupported backends in the error when nothing can serve the method', async () => {
    const a = new FakeBackend({ name: 'a', unsupported: ['getAddressInfo'] });
    const router = new ChainProviderRouter([a]);

    await expect(router.getAddressInfo('addr1')).rejects.toThrow(/not supported/);
  });
});

describe('ChainProviderRouter — live vs historical ordering', () => {
  it('de-prioritises a laggy backend for HISTORICAL reads', async () => {
    const laggy = new FakeBackend({ name: 'laggy', laggy: true });
    const fresh = new FakeBackend({ name: 'fresh' });
    // Laggy is listed FIRST, but the historical read must still prefer fresh.
    const router = new ChainProviderRouter([laggy, fresh]);

    const utxos = await router.getAddressUtxosAll('addr1');

    expect(utxos[0]?.txHash).toBe('tx-fresh');
    expect(laggy.calls).toHaveLength(0);
  });

  it('still uses a laggy backend for historical reads when it is the only one left', async () => {
    const laggy = new FakeBackend({ name: 'laggy', laggy: true });
    const fresh = new FakeBackend({ name: 'fresh', failing: true });
    const router = new ChainProviderRouter([laggy, fresh]);

    const utxos = await router.getAddressUtxosAll('addr1');

    expect(utxos[0]?.txHash).toBe('tx-laggy');
  });

  it('does NOT de-prioritise a laggy backend for LIVE reads', async () => {
    const laggy = new FakeBackend({ name: 'laggy', laggy: true });
    const fresh = new FakeBackend({ name: 'fresh' });
    const router = new ChainProviderRouter([laggy, fresh]);

    // getLatestBlock is a live method — declared priority order wins.
    const block = await router.getLatestBlock();

    expect(block.hash).toBe('hash-laggy');
  });
});

describe('CircuitBreakerManager', () => {
  it('opens after the failure threshold and blocks further attempts', () => {
    const cb = new CircuitBreakerManager({ failureThreshold: 3, resetTimeoutMs: 1000 });

    cb.recordFailure('x');
    cb.recordFailure('x');
    expect(cb.shouldAttempt('x')).toBe(true);

    cb.recordFailure('x');
    expect(cb.stateOf('x')).toBe('open');
    expect(cb.shouldAttempt('x')).toBe(false);
  });

  it('goes half-open once the reset window elapses, then closes on success', () => {
    let now = 0;
    const cb = new CircuitBreakerManager({ failureThreshold: 1, resetTimeoutMs: 500 }, () => now);

    cb.recordFailure('x');
    expect(cb.shouldAttempt('x')).toBe(false);

    now = 500;
    expect(cb.shouldAttempt('x')).toBe(true);
    expect(cb.stateOf('x')).toBe('half-open');

    cb.recordSuccess('x');
    expect(cb.stateOf('x')).toBe('closed');
  });

  it('re-opens immediately if the half-open trial fails', () => {
    let now = 0;
    const cb = new CircuitBreakerManager({ failureThreshold: 5, resetTimeoutMs: 100 }, () => now);

    for (let i = 0; i < 5; i++) cb.recordFailure('x');
    now = 100;
    cb.shouldAttempt('x'); // -> half-open
    cb.recordFailure('x'); // trial fails
    expect(cb.stateOf('x')).toBe('open');
  });

  it('resets the failure count on success so transient blips do not accumulate', () => {
    const cb = new CircuitBreakerManager({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure('x');
    cb.recordFailure('x');
    cb.recordSuccess('x');
    cb.recordFailure('x');
    expect(cb.stateOf('x')).toBe('closed');
  });
});

describe('ChainProviderRouter — breaker integration', () => {
  it('stops trying a backend once its circuit opens', async () => {
    const bad = new FakeBackend({ name: 'bad', failing: true });
    const good = new FakeBackend({ name: 'good' });
    const router = new ChainProviderRouter([bad, good], {
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    });

    await router.getLatestBlock();
    await router.getLatestBlock();
    expect(bad.calls).toHaveLength(2);

    await router.getLatestBlock(); // circuit now open — bad must be skipped
    expect(bad.calls).toHaveLength(2);
    expect(router.health()).toContainEqual({ backend: 'bad', circuit: 'open' });
  });
});

describe('RequestCoalescer', () => {
  it('shares one upstream call between identical concurrent requests', async () => {
    const coalescer = new RequestCoalescer();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'value';
    });

    const [a, b] = await Promise.all([coalescer.run('k', fn), coalescer.run('k', fn)]);

    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce different keys', async () => {
    const coalescer = new RequestCoalescer();
    const fn = vi.fn(async () => 'v');

    await Promise.all([coalescer.run('a', fn), coalescer.run('b', fn)]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry after settling, including on rejection', async () => {
    const coalescer = new RequestCoalescer();
    await expect(
      coalescer.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(coalescer.size).toBe(0);

    // A later call with the same key must actually run again.
    await expect(coalescer.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ChainProviderRouter — coalescing and timeouts', () => {
  it('coalesces identical concurrent router calls into one backend call', async () => {
    const a = new FakeBackend({ name: 'a', delayMs: 15 });
    const router = new ChainProviderRouter([a]);

    await Promise.all([router.getAddressInfo('addr1'), router.getAddressInfo('addr1')]);

    expect(a.calls).toHaveLength(1);
  });

  it('does not coalesce calls for different addresses', async () => {
    const a = new FakeBackend({ name: 'a', delayMs: 5 });
    const router = new ChainProviderRouter([a]);

    await Promise.all([router.getAddressInfo('addr1'), router.getAddressInfo('addr2')]);

    expect(a.calls).toHaveLength(2);
  });

  it('times out a slow backend and fails over', async () => {
    const slow = new FakeBackend({ name: 'slow', delayMs: 200 });
    const fast = new FakeBackend({ name: 'fast' });
    const router = new ChainProviderRouter([slow, fast], { perBackendTimeoutMs: 30 });

    const block = await router.getLatestBlock();

    expect(block.hash).toBe('hash-fast');
  });

  it('emits observability events for skips, failures and successes', async () => {
    const events: string[] = [];
    const limited = new FakeBackend({ name: 'limited', unsupported: ['getLatestBlock'] });
    const bad = new FakeBackend({ name: 'bad', failing: true });
    const good = new FakeBackend({ name: 'good' });
    const router = new ChainProviderRouter([limited, bad, good], {
      onEvent: (e) => events.push(`${e.backend}:${e.outcome}`),
    });

    await router.getLatestBlock();

    expect(events).toContain('limited:unsupported');
    expect(events).toContain('bad:error');
    expect(events).toContain('good:success');
  });
});
