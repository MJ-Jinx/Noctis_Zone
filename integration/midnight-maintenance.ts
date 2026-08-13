// ============================================================================
// Noctis Protocol — completing a contract deployed in phases
// ============================================================================
// A deploy writes the whole contract state at once: the constructor's ledger
// plus one verifier key per exported circuit. A contract with many circuits is
// therefore delivered in phases — the deploy carries the circuits needed
// first, and the rest arrive afterwards as maintenance updates, authorised by
// the contract's own maintenance authority.
//
// A verifier key compiles independently of which other circuits were built
// alongside it, so a contract completed this way holds exactly the keys a
// single-shot deploy would have. `verifyDeliveredCircuits` below is what
// proves that for a given contract rather than assuming it.
//
// WRITE BUDGET
// `submitInsertVerifierKeyTx` carries ONE key per transaction (verified
// against the installed SDK's own implementation), so each update writes one
// key plus its overhead. Run with NP_TX_COST=1 to have the real figure printed
// for every transaction rather than inferred.
//
// AUTHORITY
// Each update must be signed by the maintenance authority the deploy sealed
// in. That key is derived from the governor secret and the launch id
// (`deriveContractSigningKey`), so it can be recomputed at any time from
// material the governor already holds — no key file has to survive between the
// deploy and the updates that complete it.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { submitInsertVerifierKeyTx, verifierKeysEqual } from '@midnight-ntwrk/midnight-js-contracts';
import { operationNames } from './midnight-deploy-subset.js';

/** What a contract still needs, measured against what it should end up with. */
export interface CircuitDelivery {
  /** Circuits the compiled contract defines. */
  readonly expected: readonly string[];
  /** Circuits already on chain. */
  readonly present: readonly string[];
  /** Circuits still to be delivered, in the order given. */
  readonly missing: readonly string[];
  /**
   * Circuits on chain that the compiled contract does not define.
   *
   * Never empty for an innocent reason: it means the deployed contract and the
   * local build disagree about what this contract is.
   */
  readonly unexpected: readonly string[];
}

/**
 * Compares a deployed contract against the build that should complete it.
 *
 * `expected` is taken in its given order so a caller can decide delivery
 * priority — the circuits a launch needs soonest first.
 */
export function planCircuitDelivery(
  onChainOperations: readonly string[],
  expected: readonly string[],
): CircuitDelivery {
  const present = new Set(onChainOperations);
  const defined = new Set(expected);
  return {
    expected,
    present: [...onChainOperations],
    missing: expected.filter((name) => !present.has(name)),
    unexpected: onChainOperations.filter((name) => !defined.has(name)),
  };
}

export interface DeliveredCircuit {
  readonly circuitId: string;
  readonly txId: string;
  readonly txHash: string;
  readonly blockHeight: number;
}

export interface DeliverCircuitsOptions {
  /** Called before each transaction, so a long run reports progress as it goes. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Delivers `circuits` to an already-deployed contract, one transaction each.
 *
 * Sequential rather than concurrent, and deliberately so: every update spends
 * the same wallet and builds on the contract state the previous one produced,
 * so overlapping them would race both. Each returns before the next starts,
 * which also means a run that stops partway leaves every circuit it already
 * delivered on chain — re-running skips those, because the plan is recomputed
 * from what the chain actually holds.
 */
export async function deliverCircuits(
  providers: ContractProviders,
  // The FULL compiled contract, including circuits not yet on chain: the
  // update names the circuit being added, so a build missing it cannot
  // describe it.
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's own signature for this parameter
  compiledContract: any,
  contractAddress: string,
  circuits: readonly string[],
  { onProgress }: DeliverCircuitsOptions = {},
): Promise<DeliveredCircuit[]> {
  const delivered: DeliveredCircuit[] = [];

  for (const [index, circuitId] of circuits.entries()) {
    onProgress?.(`delivering ${circuitId} (${index + 1} of ${circuits.length})`);

    const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
    const txData = await submitInsertVerifierKeyTx(
      providers,
      compiledContract,
      contractAddress,
      circuitId,
      verifierKey,
    );

    delivered.push({
      circuitId,
      txId: txData.txId,
      txHash: txData.txHash,
      blockHeight: txData.blockHeight,
    });
    onProgress?.(`  ${circuitId} in block ${txData.blockHeight}`);
  }

  return delivered;
}

export interface CircuitVerification {
  readonly circuitId: string;
  /** Whether the contract carries this circuit at all. */
  readonly present: boolean;
  /**
   * Whether the key on chain is byte-for-byte the locally built one.
   *
   * A present circuit whose key differs is the case worth catching: it would
   * accept calls and reject every proof built against this source.
   */
  readonly keyMatches: boolean;
}

/**
 * Checks a deployed contract carries every expected circuit, with the keys
 * this build produces.
 *
 * Deliberately reports on all of them rather than throwing at the first
 * disagreement — one run should say what the contract holds, not just that
 * something is wrong with it.
 */
export async function verifyDeliveredCircuits(
  providers: ContractProviders,
  contractAddress: string,
  expected: readonly string[],
): Promise<CircuitVerification[]> {
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    throw new Error(`No contract found at ${contractAddress}, so there is nothing to verify.`);
  }
  const present = new Set(operationNames(contractState));

  const results: CircuitVerification[] = [];
  for (const circuitId of expected) {
    if (!present.has(circuitId)) {
      results.push({ circuitId, present: false, keyMatches: false });
      continue;
    }
    const local = await providers.zkConfigProvider.getVerifierKey(circuitId);
    const onChain = contractState.operation(circuitId)?.verifierKey;
    results.push({
      circuitId,
      present: true,
      keyMatches: onChain !== undefined && verifierKeysEqual(local, onChain),
    });
  }
  return results;
}
