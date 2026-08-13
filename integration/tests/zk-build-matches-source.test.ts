// Guards that the full ZK build still describes the contract in the source.
//
// WHY THIS EXISTS
// Two builds of each Compact contract sit side by side. `compiled/` is rebuilt
// from source before every test run, so it always matches. `compiled_realzk/`
// carries the prover and verifier keys and is only rebuilt by hand, because
// generating those keys takes minutes rather than seconds.
//
// So the ZK build is the one that drifts, and drift there is quiet: the tests
// go on passing against `compiled/` while anything that deploys or proves uses
// keys describing an older contract. That surfaces much later as a proof the
// chain rejects, or a deploy priced against the wrong circuit set.
//
// The comparison is on ZKIR rather than on the generated JavaScript. ZKIR is
// the compiled circuit — what a verifier key is derived from — whereas the
// JavaScript also carries source line numbers for assertion messages, which
// shift whenever a comment is added above a circuit and mean nothing to a
// proof. Comparing the JS would fail on edits that cannot affect a key.
//
// If this fails, rebuild the ZK artifacts from source:
//   compact compile <name>.compact compiled_realzk/<name>
// then check the verifier keys before deploying anything that used the old
// ones — a changed key means a contract already on chain answers to a circuit
// that no longer exists in this source.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACTS_DIR = join(process.cwd(), '..', 'contracts', 'midnight');
const FAST_BUILD = join(CONTRACTS_DIR, 'compiled');
const ZK_BUILD = join(CONTRACTS_DIR, 'compiled_realzk');

/** Only the builds that carry real keys, and only where the fast build exists to compare against. */
function zkBuiltContracts(): string[] {
  if (!existsSync(ZK_BUILD)) {
    return [];
  }
  return (
    readdirSync(ZK_BUILD, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // A build kept deliberately under another name is a snapshot of an older
      // contract, not a claim about the current source, so it is not compared.
      .filter((name) => existsSync(join(CONTRACTS_DIR, `${name}.compact`)))
      .filter((name) => existsSync(join(FAST_BUILD, name, 'zkir')))
      .filter((name) => existsSync(join(ZK_BUILD, name, 'zkir')))
  );
}

const contracts = zkBuiltContracts();

describe('the ZK build matches the contract source', () => {
  it.skipIf(contracts.length === 0)('has something to compare', () => {
    expect(contracts.length).toBeGreaterThan(0);
  });

  for (const name of contracts) {
    describe(name, () => {
      const fastDir = join(FAST_BUILD, name, 'zkir');
      const zkDir = join(ZK_BUILD, name, 'zkir');
      const circuitsIn = (dir: string) =>
        readdirSync(dir)
          .filter((file) => file.endsWith('.zkir'))
          .sort();

      it('exports the same circuits as the source', () => {
        // A circuit added or removed since the last ZK compile is the case
        // that silently changes what a deploy writes.
        expect(circuitsIn(zkDir)).toEqual(circuitsIn(fastDir));
      });

      it('compiled every circuit to the same ZKIR', () => {
        const differing = circuitsIn(fastDir).filter((file) => {
          const zkPath = join(zkDir, file);
          if (!existsSync(zkPath)) {
            return true;
          }
          return !readFileSync(join(fastDir, file)).equals(readFileSync(zkPath));
        });
        expect(differing).toEqual([]);
      });

      it('has a verifier key for every circuit', () => {
        // A missing key is not drift, but it fails the same way — at deploy,
        // on a contract that looked complete.
        const keysDir = join(ZK_BUILD, name, 'keys');
        const missing = circuitsIn(zkDir)
          .map((file) => file.replace(/\.zkir$/, ''))
          .filter((circuit) => !existsSync(join(keysDir, `${circuit}.verifier`)));
        expect(missing).toEqual([]);
      });
    });
  }
});
