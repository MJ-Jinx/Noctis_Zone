// ============================================================================
// Noctis Protocol — sync Midnight wallets to a usable DUST balance
// ============================================================================
// A wallet becomes able to pay fees only once its dust sub-wallet has replayed
// enough chain history to see the DUST its registered NIGHT has generated. That
// replay is the expensive part: the dust state grows as it advances and does not
// collapse (upstream midnightntwrk/midnight-wallet#639), so a single process can
// exhaust its heap before reaching the tip.
//
// This runs that replay as something a process is allowed to lose. Two things
// make it converge:
//
//   - SNAPSHOTS. midnight-wallet-state-store.ts banks sync progress every 30
//     seconds, from the first minute, without waiting for a synced wallet. A run
//     that dies has still moved its wallet forward.
//   - A SUPERVISOR. Each attempt runs in its own child process with a fresh
//     heap, resuming from the last snapshot. Progress therefore accumulates
//     across attempts even though no single attempt reaches the tip.
//
// One invocation replays its wallets one after another. Several invocations can
// run side by side, and measured on Preprod that is worth doing: ten wallets
// together held ~1.5 GB in total, so memory is not what limits concurrency. What
// does limit it is throughput — a wallet replaying alone advanced at ~230 blocks
// per second and ~130 with nine siblings, because they contend for the same
// indexer. Ten at once still finishes far sooner than ten in sequence.
//
// The attempt log is also the diagnostic: each attempt reports the dust applied
// index it reached. Those should climb. If they stop climbing while each attempt
// still spends its whole budget, the restored state is what fills the heap, and
// no amount of heap or retrying changes that — worth reporting upstream with the
// numbers rather than absorbing quietly.
//
// Input:  {"network":"preprod","proofServerUrl":"http://127.0.0.1:6310",
//          "snapshotDir":"…","passphrase":"…",
//          "wallets":[{"role":"buyer_2","seedHex":"<64 hex>"}, …],
//          "attemptSeconds":600,"maxAttempts":8,"heapMb":4096,
//          "dustColdStart":false}
// Output: {"results":{"<role>":{"status":"synced","dustAtomic":"…",
//                               "appliedIndex":"…","attempts":n}
//                     | {"status":"incomplete","attempts":n,"progress":[…]}
//                     | {"error":"…"}}}
//
// The passphrase arrives on stdin and is handed to the child the same way,
// never as an argument — arguments are readable from the process list by anyone
// on the host.
// ============================================================================

import { spawn } from 'node:child_process';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import {
  buildServerWallet,
  defaultNetworkConfig,
  type MidnightNetwork,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { startPeriodicSave, WalletStateStore } from '../midnight-wallet-state-store.js';

interface WalletInput {
  role: string;
  seedHex: string;
}

interface Input {
  network: MidnightNetwork;
  proofServerUrl: string;
  /** Where snapshots live. Must be outside the repository — these describe real holdings. */
  snapshotDir: string;
  passphrase: string;
  wallets: WalletInput[];
  /** How long one attempt may run before it is stopped and restarted with a fresh heap. */
  attemptSeconds?: number;
  maxAttempts?: number;
  /** Child heap ceiling. Generous, but finite: the point is a clean restart, not a bigger wall. */
  heapMb?: number;
  /** Replay dust from chain instead of from its snapshot. See ServerWalletSnapshotOptions. */
  dustColdStart?: boolean;
}

interface AttemptResult {
  status: 'synced' | 'incomplete';
  dustAtomic: string;
  /**
   * How many spendable DUST coins the wallet actually holds.
   *
   * Reported alongside the balance because they answer different questions and
   * can disagree. `balance(time)` is a GENERATED figure computed for a moment
   * in time; this is the count of coins the fee balancer has to choose from. A
   * healthy balance with no coins behind it still cannot pay for anything, and
   * a balance spread over very many small coins makes balancing expensive —
   * neither is visible from the balance alone.
   */
  dustCoins: number;
  /** The largest single coin, which is what a one-input fee payment can draw on. */
  largestDustCoinAtomic: string;
  appliedIndex: string;
  /** How far the dust wallet still trails what it considers relevant. Zero when synced. */
  dustLag: string;
  restoredFrom: readonly string[];
}

const DEFAULTS = { attemptSeconds: 600, maxAttempts: 8, heapMb: 4096 };

const log = (message: string) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeAndExit(payload: unknown, code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(code));
  });
}

// ---------------------------------------------------------------------------
// Worker — one attempt at one wallet, in its own process
// ---------------------------------------------------------------------------

interface WorkerInput extends Omit<Input, 'wallets'> {
  wallet: WalletInput;
}

async function runWorker(): Promise<never> {
  const input: WorkerInput = JSON.parse(await readStdin());
  const { role, seedHex } = input.wallet;
  const attemptMs = (input.attemptSeconds ?? DEFAULTS.attemptSeconds) * 1000;

  const store = new WalletStateStore(input.snapshotDir, input.passphrase);
  const config = defaultNetworkConfig(input.network, input.proofServerUrl);

  const wallet = await buildServerWallet(Buffer.from(seedHex, 'hex'), config, {
    store,
    accountId: role,
    dustColdStart: input.dustColdStart,
    onRestore: (restored) => log(`${role}: resumed ${restored.join(', ')} from snapshot`),
  });
  if (wallet.restoredFrom.length === 0) log(`${role}: no usable snapshot — replaying from chain`);

  const saver = startPeriodicSave(wallet.facade, store, role, wallet.snapshotGuards, {
    onSave: (_saved, sizes) => {
      const parts = Object.entries(sizes).map(([kind, size]) => `${kind} ${(size / 1024).toFixed(0)}KB`);
      log(`${role}: banked ${parts.join(', ')}`);
    },
    onError: (err) => log(`${role}: snapshot failed — ${err instanceof Error ? err.message : String(err)}`),
  });

  // Report progress and heap on a slower cadence than the snapshot loop. Heap is
  // here because the attempt log is meant to answer "is this converging or is the
  // state itself the problem", and that cannot be read from progress alone.
  //
  // Lag is measured against `highestRelevantWalletIndex`, which is what the SDK
  // itself compares in `isCompleteWithin`. `highestIndex` is NOT that number and
  // is left at 0 for the dust wallet, so a gap computed from it means nothing.
  //
  // Only the dust lag is printed. The other two sub-wallets type their `progress`
  // differently in the SDK — shielded and dust expose the progress DATA, while
  // unshielded exposes the ops object, which carries no indices — so there is no
  // one expression that reads a lag from all three. Whether they are caught up is
  // covered by `isSynced` below, which the SDK computes over all three itself.
  const describe = (state: FacadeState) => {
    const { appliedIndex, highestRelevantWalletIndex } = state.dust.progress;
    const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
    return (
      `${role}: dust ${appliedIndex} (lag ${highestRelevantWalletIndex - appliedIndex}), ` +
      `synced=${state.isSynced}, heap ${heapMb}MB`
    );
  };
  let last: FacadeState | undefined;
  const ticker = setInterval(() => {
    if (last) log(describe(last));
  }, 30_000);
  ticker.unref?.();
  try {
    // Done when the wallet can actually SPEND, which takes both conditions.
    //
    // A visible DUST balance alone is not enough. A wallet that has replayed far
    // enough to see its DUST can still be a long way behind the chain, and a
    // transaction it builds then references a Merkle root the node no longer
    // keeps — rejected as `Zswap.Invalid.UnknownMerkleRoot` (241), whose
    // documented fix is to resync against the current head and rebuild. So this
    // waits for the facade's own definition of synced, which requires all three
    // sub-wallets to be strictly caught up, and only then checks the balance.
    const synced = await waitForWalletState(
      wallet.facade,
      (state) => {
        last = state;
        return state.isSynced && state.dust.balance(new Date()) > 0n;
      },
      attemptMs,
      'the wallet to catch up to the chain head with spendable DUST',
    );
    last = synced;
    log(describe(synced));

    clearInterval(ticker);
    await saver.stop();
    await wallet.shutdown();

    const dustCoins = synced.dust.availableCoins;
    return await writeAndExit(
      {
        status: 'synced',
        dustAtomic: synced.dust.balance(new Date()).toString(),
        dustCoins: dustCoins.length,
        largestDustCoinAtomic: dustCoins
          .reduce((largest, coin) => (coin.generatedNow > largest ? coin.generatedNow : largest), 0n)
          .toString(),
        appliedIndex: synced.dust.progress.appliedIndex.toString(),
        dustLag: (synced.dust.progress.highestRelevantWalletIndex - synced.dust.progress.appliedIndex).toString(),
        restoredFrom: wallet.restoredFrom,
      } satisfies AttemptResult,
      0,
    );
  } catch {
    // The budget ran out. That is an ordinary outcome, not an error: the
    // snapshot below is the whole point, and the next attempt continues from it.
    clearInterval(ticker);
    if (last) log(describe(last));
    await saver.stop();
    await wallet.shutdown().catch(() => {});

    return await writeAndExit(
      {
        status: 'incomplete',
        dustAtomic: last ? last.dust.balance(new Date()).toString() : '0',
        dustCoins: last ? last.dust.availableCoins.length : 0,
        largestDustCoinAtomic: last
          ? last.dust.availableCoins
              .reduce((largest, coin) => (coin.generatedNow > largest ? coin.generatedNow : largest), 0n)
              .toString()
          : '0',
        appliedIndex: last ? last.dust.progress.appliedIndex.toString() : '0',
        dustLag: last
          ? (last.dust.progress.highestRelevantWalletIndex - last.dust.progress.appliedIndex).toString()
          : '0',
        restoredFrom: wallet.restoredFrom,
      } satisfies AttemptResult,
      0,
    );
  }
}

// ---------------------------------------------------------------------------
// Supervisor — attempts per wallet, wallets one at a time
// ---------------------------------------------------------------------------

interface ChildOutcome {
  result?: AttemptResult;
  /** Set when the child died rather than reporting — an OOM kill looks like this. */
  died?: string;
}

function runAttempt(input: WorkerInput, heapMb: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    // argv[1] rather than this module's own URL: it is the path the runtime was
    // actually given, so it stays correct whether this runs from a bundle or
    // through a loader.
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, process.argv[1], '--worker'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.on('close', (code, signal) => {
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed.split('\n').pop() ?? '') as AttemptResult & { error?: string };
          // A worker that reported an error is not a worker that made progress.
          // Reading it as one would log an attempt with empty numbers and hide
          // the actual reason in a field nobody prints.
          resolve(parsed.error ? { died: parsed.error } : { result: parsed });
          return;
        } catch {
          /* fall through to the died path */
        }
      }
      resolve({ died: signal ? `signal ${signal}` : `exit code ${code}` });
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

async function runSupervisor(input: Input): Promise<never> {
  const attemptSeconds = input.attemptSeconds ?? DEFAULTS.attemptSeconds;
  const maxAttempts = input.maxAttempts ?? DEFAULTS.maxAttempts;
  const heapMb = input.heapMb ?? DEFAULTS.heapMb;
  const results: Record<string, unknown> = {};

  // Serial, deliberately. See this file's header.
  for (const wallet of input.wallets) {
    const progress: string[] = [];
    let synced: AttemptResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts && !synced; attempt++) {
      log(`${wallet.role}: attempt ${attempt}/${maxAttempts} (heap ${heapMb}MB, budget ${attemptSeconds}s)`);
      const outcome = await runAttempt({ ...input, wallet }, heapMb);

      if (outcome.died) {
        // Expected, and survivable: whatever the child banked before dying is
        // already on disk, so the next attempt starts from there.
        log(`${wallet.role}: attempt ${attempt} died (${outcome.died}) — resuming from the last snapshot`);
        progress.push(`attempt ${attempt}: died (${outcome.died})`);
        continue;
      }

      const result = outcome.result;
      if (!result) {
        progress.push(`attempt ${attempt}: no result`);
        continue;
      }

      progress.push(`attempt ${attempt}: dust ${result.dustAtomic}, applied ${result.appliedIndex}`);
      if (result.status === 'synced') synced = result;
    }

    if (synced) {
      log(
        `${wallet.role}: synced — ${synced.dustAtomic} DUST spendable across ${synced.dustCoins} coin(s), largest ${synced.largestDustCoinAtomic}`,
      );
      results[wallet.role] = { ...synced, attempts: progress.length };
    } else {
      log(`${wallet.role}: not synced within ${maxAttempts} attempts`);
      results[wallet.role] = { status: 'incomplete', attempts: progress.length, progress };
    }
  }

  return await writeAndExit({ results }, 0);
}

async function main(): Promise<never> {
  if (process.argv.includes('--worker')) return await runWorker();
  return await runSupervisor(JSON.parse(await readStdin()) as Input);
}

main().catch(async (err) => {
  await writeAndExit({ error: err instanceof Error ? err.message : String(err) }, 1);
});
