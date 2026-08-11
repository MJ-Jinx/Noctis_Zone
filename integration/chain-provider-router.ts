/**
 * chain-provider-router.ts — multi-provider failover for Cardano chain reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * `blockfrost-client.ts` talks to exactly one provider. A Blockfrost outage or
 * quota exhaustion currently breaks every TypeScript read path (the PHP plugin
 * has a narrow Koios fallback for account reads only — see `koios-client.php`).
 * This module is the failover layer that gap needs.
 *
 * ATTRIBUTION
 * -----------
 * The routing design here is adapted from the multi-provider backend layer in
 * ODATANO (https://github.com/ODATANO/ODATANO, Apache-2.0) — specifically its
 * `srv/blockchain/` tree (`cardano-backend.ts`, `cardano-client.ts`,
 * `circuit-breaker.ts`, `request-coalescer.ts`). Their SAP/CAP-specific pieces
 * are not used; what is borrowed is the architecture and, importantly, one
 * hard-won behavioural detail documented in their own source:
 *
 *   A backend that STRUCTURALLY cannot serve a method must be skipped WITHOUT
 *   counting a circuit-breaker failure.
 *
 * Their comment records why: without that distinction a backend either
 * fabricated placeholder data (which live-preferring routing then preferred
 * over correct historical data), or its thrown errors "poisoned the breaker" —
 * tripping it for methods it could otherwise serve perfectly well. That is the
 * single least obvious part of this design and the reason `unsupportedMethods`
 * is a first-class field on `ChainBackend` rather than an exception type.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a drop-in replacement for `BlockfrostClient`. It deliberately covers only
 * the read methods a second provider can actually serve faithfully; anything
 * else stays a direct Blockfrost call. See `chain-backends.ts` for the exact
 * per-backend coverage and why each gap exists.
 */

// ============================================================================
// METHOD SURFACE
// ============================================================================

/**
 * The read methods that participate in failover. Kept as a string-literal union
 * (not an enum) so `unsupportedMethods` sets are checked at compile time — a
 * typo in a backend's coverage declaration is a type error, not a silent
 * always-supported method.
 */
export type ChainMethod = 'getLatestBlock' | 'getAddressInfo' | 'getAddressUtxosAll' | 'getAddressTransactionsAll';

/**
 * `true` for methods that must reflect the CURRENT chain tip, `false` for
 * methods answering historical questions.
 *
 * This drives the same live-vs-historical split ODATANO uses: a backend that
 * lags (or serves only currently-unspent state) is acceptable for a tip query
 * but can silently return wrong answers for history, so it should not be
 * preferred there. Backends declare `laggy: true` to be de-prioritised for
 * historical reads.
 */
const PREFERS_LIVE: Readonly<Record<ChainMethod, boolean>> = {
  getLatestBlock: true,
  getAddressInfo: false,
  getAddressUtxosAll: false,
  getAddressTransactionsAll: false,
};

// ============================================================================
// SHARED RESULT SHAPES
// ============================================================================

/** Normalised across providers — callers must not depend on provider field names. */
export interface RouterBlockInfo {
  height: number;
  epoch: number;
  slot: number;
  hash: string;
}

/**
 * Deliberately narrow: only fields EVERY backend can serve faithfully.
 *
 * Balance is NOT here even though Koios returns it, because our typed
 * Blockfrost client does not expose one — a field that is real from one
 * provider and null from another is precisely the "fabricated placeholder
 * data" failure this design exists to avoid. Callers needing a balance should
 * derive it from `getAddressUtxosAll`, which both backends serve identically.
 */
export interface RouterAddressInfo {
  address: string;
  /** Bech32 stake address, or null for enterprise/Byron addresses. */
  stakeAddress: string | null;
}

export interface RouterAddressUtxo {
  txHash: string;
  outputIndex: number;
  amount: Array<{ unit: string; quantity: string }>;
}

/**
 * ORDER IS PART OF THIS SHAPE: oldest first, by block time.
 *
 * Callers read index 0 as "the address's earliest transaction" — that is how
 * wallet age is derived. Blockfrost asks for `order=asc` in its query string
 * and Koios does not sort at all, so leaving order to whichever backend
 * answered would make the same address a different age depending on which
 * provider was up. Both backends sort before returning; see the note on
 * `sortOldestFirst` in chain-backends.ts.
 */
export interface RouterAddressTransaction {
  txHash: string;
  blockHeight: number;
  blockTime: number;
}

// ============================================================================
// BACKEND CONTRACT
// ============================================================================

export interface ChainBackend {
  readonly name: string;

  /**
   * Methods this backend structurally cannot serve. Calls to these are skipped
   * WITHOUT recording a circuit-breaker failure — see the attribution note.
   */
  readonly unsupportedMethods: ReadonlySet<ChainMethod>;

  /**
   * Set when the backend may lag the tip or only exposes currently-unspent
   * state. Such a backend is de-prioritised (not excluded) for historical reads.
   */
  readonly laggy?: boolean;

  getLatestBlock(): Promise<RouterBlockInfo>;
  getAddressInfo(address: string): Promise<RouterAddressInfo>;
  getAddressUtxosAll(address: string): Promise<RouterAddressUtxo[]>;
  getAddressTransactionsAll(address: string): Promise<RouterAddressTransaction[]>;
}

// ============================================================================
// ERRORS
// ============================================================================

/** Terminal case: every eligible backend failed, was open, or was unsupported. */
export class AllBackendsFailedError extends Error {
  constructor(
    readonly method: ChainMethod,
    readonly attempts: readonly { backend: string; reason: string }[],
  ) {
    const detail = attempts.map((a) => `${a.backend}: ${a.reason}`).join('; ');
    super(`All chain backends failed for ${method} — ${detail || 'no eligible backend'}`);
    this.name = 'AllBackendsFailedError';
  }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before a single trial call is allowed. */
  resetTimeoutMs: number;
}

const DEFAULT_BREAKER: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
};

type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerEntry {
  failures: number;
  openedAt: number;
  state: BreakerState;
}

/**
 * One breaker per backend NAME (not per method) — a provider that is down is
 * down for everything it does support. `unsupportedMethods` is what keeps a
 * method-shaped gap from being mistaken for an outage.
 */
export class CircuitBreakerManager {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly options: CircuitBreakerOptions = DEFAULT_BREAKER,
    /** Injectable for tests; defaults to real wall-clock. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  private entry(name: string): BreakerEntry {
    let e = this.entries.get(name);
    if (!e) {
      e = { failures: 0, openedAt: 0, state: 'closed' };
      this.entries.set(name, e);
    }
    return e;
  }

  shouldAttempt(name: string): boolean {
    const e = this.entry(name);
    if (e.state === 'closed') return true;
    if (e.state === 'half-open') return true;
    // open — allow a single trial once the reset window has elapsed
    if (this.now() - e.openedAt >= this.options.resetTimeoutMs) {
      e.state = 'half-open';
      return true;
    }
    return false;
  }

  recordSuccess(name: string): void {
    const e = this.entry(name);
    e.failures = 0;
    e.state = 'closed';
    e.openedAt = 0;
  }

  recordFailure(name: string): void {
    const e = this.entry(name);
    e.failures += 1;
    if (e.state === 'half-open' || e.failures >= this.options.failureThreshold) {
      e.state = 'open';
      e.openedAt = this.now();
    }
  }

  /** Introspection for health endpoints and tests. */
  stateOf(name: string): BreakerState {
    return this.entry(name).state;
  }
}

// ============================================================================
// REQUEST COALESCER
// ============================================================================

/**
 * Deduplicates identical in-flight requests. Two callers asking for the same
 * address's UTxOs at the same moment share one upstream call — which matters
 * most precisely when a provider is degraded and retries are stacking up.
 */
export class RequestCoalescer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const p = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p as Promise<T>;
  }

  get size(): number {
    return this.inFlight.size;
  }
}

// ============================================================================
// ROUTER
// ============================================================================

export interface ChainProviderRouterOptions {
  /** Per-backend timeout for a single call. */
  perBackendTimeoutMs?: number;
  breaker?: CircuitBreakerOptions;
  now?: () => number;
  /** Called when a backend fails or is skipped; defaults to no-op. */
  onEvent?: (event: {
    method: ChainMethod;
    backend: string;
    outcome: 'unsupported' | 'circuit-open' | 'error' | 'timeout' | 'success';
    reason?: string;
  }) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ChainProviderRouter {
  private readonly breaker: CircuitBreakerManager;
  private readonly coalescer = new RequestCoalescer();
  private readonly timeoutMs: number;
  private readonly onEvent: NonNullable<ChainProviderRouterOptions['onEvent']>;

  /**
   * @param backends Priority-ordered. Index 0 is tried first for a method it
   *                 supports; `laggy` backends are pushed to the back for
   *                 historical reads.
   */
  constructor(
    private readonly backends: readonly ChainBackend[],
    options: ChainProviderRouterOptions = {},
  ) {
    if (backends.length === 0) {
      throw new Error('ChainProviderRouter requires at least one backend');
    }
    this.breaker = new CircuitBreakerManager(options.breaker, options.now);
    this.timeoutMs = options.perBackendTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Ordered candidates for a method: supported first, laggy last on history. */
  private candidates(method: ChainMethod): ChainBackend[] {
    const eligible = this.backends.filter((b) => !b.unsupportedMethods.has(method));
    if (PREFERS_LIVE[method]) return eligible;
    // Historical read — a lagging backend is a last resort, never a preference.
    return [...eligible.filter((b) => !b.laggy), ...eligible.filter((b) => b.laggy)];
  }

  private async withTimeout<T>(backend: string, fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${backend} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run<T>(method: ChainMethod, coalesceKey: string, invoke: (b: ChainBackend) => Promise<T>): Promise<T> {
    return this.coalescer.run(`${method}:${coalesceKey}`, async () => {
      const attempts: Array<{ backend: string; reason: string }> = [];

      // Backends that cannot serve this method at all — recorded for the error
      // message, but deliberately NOT counted against their circuit breaker.
      for (const b of this.backends) {
        if (b.unsupportedMethods.has(method)) {
          attempts.push({ backend: b.name, reason: 'method not supported by this provider' });
          this.onEvent({ method, backend: b.name, outcome: 'unsupported' });
        }
      }

      for (const backend of this.candidates(method)) {
        if (!this.breaker.shouldAttempt(backend.name)) {
          attempts.push({ backend: backend.name, reason: 'circuit open' });
          this.onEvent({ method, backend: backend.name, outcome: 'circuit-open' });
          continue;
        }

        try {
          const result = await this.withTimeout(backend.name, () => invoke(backend));
          this.breaker.recordSuccess(backend.name);
          this.onEvent({ method, backend: backend.name, outcome: 'success' });
          return result;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.breaker.recordFailure(backend.name);
          attempts.push({ backend: backend.name, reason });
          this.onEvent({
            method,
            backend: backend.name,
            outcome: reason.includes('timed out') ? 'timeout' : 'error',
            reason,
          });
        }
      }

      throw new AllBackendsFailedError(method, attempts);
    });
  }

  // --- Public API (mirrors ChainBackend, with failover) ---

  getLatestBlock(): Promise<RouterBlockInfo> {
    return this.run('getLatestBlock', '', (b) => b.getLatestBlock());
  }

  getAddressInfo(address: string): Promise<RouterAddressInfo> {
    return this.run('getAddressInfo', address, (b) => b.getAddressInfo(address));
  }

  getAddressUtxosAll(address: string): Promise<RouterAddressUtxo[]> {
    return this.run('getAddressUtxosAll', address, (b) => b.getAddressUtxosAll(address));
  }

  getAddressTransactionsAll(address: string): Promise<RouterAddressTransaction[]> {
    return this.run('getAddressTransactionsAll', address, (b) => b.getAddressTransactionsAll(address));
  }

  /** Health introspection — for a status endpoint or an ops check. */
  health(): Array<{ backend: string; circuit: string }> {
    return this.backends.map((b) => ({ backend: b.name, circuit: this.breaker.stateOf(b.name) }));
  }
}
