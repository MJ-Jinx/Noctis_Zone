// ============================================================================
// Noctis Protocol — deploying a contract's circuits across two transactions
// ============================================================================
// WHAT A DEPLOY WRITES
// Creating a Midnight contract writes its whole on-chain state in one go: the
// constructor's initial ledger state, plus one verifier key for every exported
// circuit. A block caps how many bytes may be written in it — Preprod and the
// ledger's own initial parameters both put `bytes_written` at 50,000 — and a
// transaction that writes more than a block allows cannot be included in one.
// Verifier keys dominate that budget; ours run ~2.1 KB each.
//
// WHAT THIS MODULE DOES
// It lets a deploy carry a chosen subset of a contract's circuits, so the rest
// can be added afterwards with `submitInsertVerifierKeyTx` against the same
// contract. The deployed contract ends up holding exactly what a single-shot
// deploy would have, because a circuit's verifier key does not depend on which
// other circuits are exported alongside it — verified by compiling this
// contract twice with different circuit sets and comparing key hashes, which
// matched byte for byte every time.
//
// WHY IT WRAPS THE CONTRACT CLASS
// `ContractExecutable` builds the deploy state by calling the compiled
// contract's own `initialState`, which registers an operation per circuit, and
// then fills in a key for every id in `provableCircuits`. Both come from the
// contract object handed to `CompiledContractOps.make`, so subclassing it is
// the whole intervention: no fork of the SDK, no second `.compact` variant to
// drift from the real one, and the keys still come from the same build the
// later calls use.
//
// The subclass is FOR DEPLOYING ONLY. Connecting to the contract afterwards —
// `findDeployedContract`, every `.callTx` — must use the unmodified class, or
// the deferred circuits are unreachable through it.
// ============================================================================

import { ContractState } from '@midnight-ntwrk/compact-runtime';

/**
 * The entry points registered on a contract state, as strings.
 *
 * `operations()` is declared as `Array<string | Uint8Array>` because an entry
 * point may be named by raw bytes. Every circuit compactc generates is named
 * by a string, so anything else here is not something a caller could have
 * asked to defer by name, and is reported rather than silently dropped.
 */
export function operationNames(state: ContractState): string[] {
  return state.operations().map((operation) => {
    if (typeof operation !== 'string') {
      throw new Error(
        'This contract has an entry point that is not named by a string, which this module cannot address by name.',
      );
    }
    return operation;
  });
}

/**
 * A copy of `state` carrying every operation except `defer`.
 *
 * The input is left alone: a caller that keeps using the full state — to
 * measure it, or to build the maintenance updates — still has it intact.
 *
 * Throws rather than trimming nothing if a deferred name is not actually an
 * operation on this contract. A typo would otherwise deploy the complete set
 * and fail much later, on a transaction that has already been proven and paid
 * for, with an error naming the block limit rather than the typo.
 */
export function trimContractState(state: ContractState, defer: readonly string[]): ContractState {
  const present = operationNames(state);
  const deferred = new Set(defer);

  for (const name of deferred) {
    if (!present.includes(name)) {
      throw new Error(
        `Cannot defer "${name}": this contract has no such circuit. Its circuits are: ${present.join(', ')}.`,
      );
    }
  }
  const kept = present.filter((name) => !deferred.has(name));
  if (kept.length === 0) {
    throw new Error('Cannot defer every circuit — the deployed contract would have no entry points at all.');
  }

  const trimmed = new ContractState();
  trimmed.data = state.data;
  trimmed.maintenanceAuthority = state.maintenanceAuthority;
  trimmed.balance = state.balance;
  for (const name of kept) {
    const operation = state.operation(name);
    if (!operation) {
      throw new Error(`Circuit "${name}" is registered on this contract but has no operation to copy.`);
    }
    trimmed.setOperation(name, operation);
  }
  return trimmed;
}

/** What a caller needs to complete the deploy, and to check it did. */
export interface DeploySubset<Ctor> {
  /** Pass this to `CompiledContractOps.make` in place of the real class. */
  contract: Ctor;
  /** The circuits this deploy leaves out, in a stable order. */
  deferred: string[];
}

/**
 * A deploy-only view of a compiled contract class that registers every circuit
 * except `defer`.
 *
 * `defer` is validated against the contract's real circuit list when the class
 * is constructed, so a name that does not exist fails before a wallet, a proof
 * server, or the chain is involved.
 */
export function deferCircuitsForDeploy<Ctor extends new (...args: never[]) => unknown>(
  ctor: Ctor,
  defer: readonly string[],
): DeploySubset<Ctor> {
  const deferred = [...new Set(defer)].sort();

  // A plain subclass: `ContractExecutable` constructs this with the witnesses
  // exactly as it would the real class, and everything not named below — the
  // circuits themselves, the witnesses, the private state — is inherited
  // untouched.
  class DeploySubsetContract extends (ctor as new (...args: never[]) => Record<string, unknown>) {
    constructor(...args: never[]) {
      super(...args);

      const provable = this.provableCircuits as Record<string, unknown>;
      const missing = deferred.filter((name) => !(name in provable));
      if (missing.length > 0) {
        throw new Error(
          `Cannot defer ${missing.map((name) => `"${name}"`).join(', ')}: not a circuit on this contract. ` +
            `Its circuits are: ${Object.keys(provable).sort().join(', ')}.`,
        );
      }
      if (deferred.length === Object.keys(provable).length) {
        throw new Error('Cannot defer every circuit — the deployed contract would have no entry points at all.');
      }

      // The executable asks this object which circuits need a verifier key.
      this.provableCircuits = Object.fromEntries(Object.entries(provable).filter(([name]) => !deferred.includes(name)));
    }

    initialState(...args: never[]) {
      const result = (super.initialState as (...a: never[]) => { currentContractState: ContractState })(...args);
      return { ...result, currentContractState: trimContractState(result.currentContractState, deferred) };
    }
  }

  return { contract: DeploySubsetContract as unknown as Ctor, deferred };
}
