// Tests for indexer-client.ts's consumption/termination logic
// (consumeUnshieldedTransactions), extracted specifically so it could be
// tested against a mock Stream without opening a real WebSocket connection
// to a live Midnight indexer. See indexer-client.ts's own header comment
// for the full termination-condition rationale this covers: the
// highestTransactionId watermark race (merged backlog+progress stream,
// not sequenced), the zero-history short-circuit, and clean-stream-end
// handling. The real wrapper (getUnshieldedNightBalance) that wires this
// to UnshieldedTransactions.run + WsSubscriptionClient.layer is
// integration-tested against a live indexer, not unit-tested here.

import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { consumeUnshieldedTransactions, type UnshieldedTransactionEvent } from '../indexer-client.js';

const NIGHT_TOKEN = 'night-token-type';
const OTHER_TOKEN = 'some-other-token-type';

function progress(highestTransactionId: number): UnshieldedTransactionEvent {
  return {
    unshieldedTransactions: {
      type: 'UnshieldedTransactionsProgress',
      highestTransactionId,
    },
  };
}

function tx(
  id: number,
  createdUtxos: { tokenType: string; value: string | number }[],
  spentUtxos: { tokenType: string; value: string | number }[] = [],
): UnshieldedTransactionEvent {
  return {
    unshieldedTransactions: {
      type: 'UnshieldedTransaction',
      createdUtxos,
      spentUtxos,
      transaction: { id },
    },
  };
}

function run(events: UnshieldedTransactionEvent[]) {
  const stream = Stream.fromIterable(events);
  // Stream.toPull requires a real effect/Scope in context (scoped resource
  // management for the pull) — the real wrapper (getUnshieldedNightBalance)
  // provides this via Effect.scoped, so the test helper must too.
  return Effect.runPromise(Effect.scoped(consumeUnshieldedTransactions(stream, NIGHT_TOKEN)));
}

describe('indexer-client.ts — consumeUnshieldedTransactions', () => {
  it('normal backlog: sums created UTXOs up to the watermark transaction', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 500 }]),
      progress(2),
    ]);
    expect(result.balance).toBe(1500n);
    expect(result.transactionsProcessed).toBe(2);
  });

  it('subtracts spent UTXOs of the same token type', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(2, [], [{ tokenType: NIGHT_TOKEN, value: 300 }]),
      progress(2),
    ]);
    expect(result.balance).toBe(700n);
  });

  it('ignores UTXOs of a different token type entirely', async () => {
    const result = await run([
      tx(1, [
        { tokenType: NIGHT_TOKEN, value: 1000 },
        { tokenType: OTHER_TOKEN, value: 99999 },
      ]),
      progress(1),
    ]);
    expect(result.balance).toBe(1000n);
  });

  it('out-of-order progress arrival: a progress event declaring a real watermark arrives before the backlog transaction reaching it — must not terminate until that transaction is actually seen', async () => {
    // The progress event arrives FIRST (as it can in a merged, unsequenced
    // stream — see this module's own header comment), naming watermark 3,
    // but transaction id 3 itself arrives afterward. Termination must wait
    // for the real transaction, not fire the moment the progress event is
    // read.
    const result = await run([
      progress(3),
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
      tx(3, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
    ]);
    expect(result.balance).toBe(300n);
    expect(result.transactionsProcessed).toBe(3);
  });

  it('zero-history address: a watermark of 0 with no transaction ever seen terminates immediately with balance 0', async () => {
    const result = await run([progress(0)]);
    expect(result.balance).toBe(0n);
    expect(result.transactionsProcessed).toBe(0);
  });

  it('clean stream end: an exhausted stream with no explicit termination condition met does not hang and returns what was accumulated', async () => {
    // No progress event at all — the stream just ends. Effect.either(pull)
    // resolving to Left(None) must break the loop, not hang or throw.
    const result = await run([tx(1, [{ tokenType: NIGHT_TOKEN, value: 42 }])]);
    expect(result.balance).toBe(42n);
    expect(result.transactionsProcessed).toBe(1);
  });

  it('stops processing further events in the same chunk once the watermark transaction is reached', async () => {
    // If a later "phantom" transaction appeared in the same batch after
    // the watermark tx (shouldn't happen against a real indexer, but the
    // loop's own `break` must not silently keep summing past its stated
    // termination point).
    const result = await run([tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }]), progress(1)]);
    expect(result.balance).toBe(100n);
    expect(result.transactionsProcessed).toBe(1);
  });

  it('propagates a real stream error instead of silently returning a partial balance', async () => {
    const boom = new Error('indexer connection dropped');
    const stream = Stream.concat(
      Stream.fromIterable<UnshieldedTransactionEvent>([tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }])]),
      Stream.fail(boom),
    );
    await expect(Effect.runPromise(Effect.scoped(consumeUnshieldedTransactions(stream, NIGHT_TOKEN)))).rejects.toThrow(
      /indexer connection dropped/,
    );
  });

  it('handles multiple registrants/transactions with mixed created and spent UTXOs across the full backlog', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 5000 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 2000 }], [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(3, [], [{ tokenType: NIGHT_TOKEN, value: 500 }]),
      progress(3),
    ]);
    // 5000 + 2000 - 1000 - 500 = 5500
    expect(result.balance).toBe(5500n);
    expect(result.transactionsProcessed).toBe(3);
  });
});
