// Every hashed value leads with a domain constant, and no two in a contract share one.
//
// WHY THIS EXISTS
// `persistentHash` hashes a value's ENCODED FIELDS, not its type. Two
// structs with the same field types in the same order hash identically for
// the same values, and a `Vector<n, Bytes<32>>` hashes identically to an
// n-field struct of `Bytes<32>` — both confirmed against the real runtime.
// So the declared type separates nothing. What separates a registration
// commitment from a buy commitment from a Merkle node is the distinct
// 32-byte constant each one hashes first, and nothing but convention was
// keeping that convention.
//
// This makes it checkable: a new hashed struct that forgets its domain, or
// reuses one already taken in the same file, fails here rather than
// silently joining another value's space.
//
// Domain strings are deliberately SHARED across contracts where the hashed
// object is the same thing — the two DarkVeil implementations compute an
// identical buy commitment on purpose, and one off-chain twin serves both.
// Uniqueness is therefore a per-file rule: a collision only matters between
// two values the same contract compares, and every launch scopes its own
// hashes by a distinct `launchId` regardless.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACTS_DIR = join(import.meta.dirname, '..');

/** How many hashed preimages each contract has. Pinned so a reader that finds none can't pass. */
const EXPECTED_HASH_SITES: Record<string, number> = {
  'bonding_curve.compact': 11,
  'creator_escrow.compact': 3,
  'cto_governance.compact': 6,
  'eligibility_gate.compact': 10,
  'lp_escrow.compact': 2,
  'staking_pool.compact': 8,
  'treasury.compact': 1,
  'vesting.compact': 2,
};

/** Drops `//` comments, which discuss `persistentHash` in prose in several files. */
function stripComments(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (inString) {
      out += c;
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

function closingIndex(src: string, openAt: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open}${close} from index ${openAt}`);
}

/** First declared field of each `struct` — declaration order is what the encoding follows. */
function firstFields(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const decl = /\bstruct\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m = decl.exec(src);
  while (m !== null) {
    const body = (m[2] as string).trim();
    const first = body.split(';')[0]?.trim() ?? '';
    out.set(m[1] as string, first.replace(/\s+/g, ' '));
    m = decl.exec(src);
  }
  return out;
}

interface HashSite {
  /** The type argument: a struct name, or `Vector<n, Bytes<32>>`. */
  type: string;
  /** The domain string this preimage leads with, or null if it leads with something else. */
  domain: string | null;
}

function hashSites(src: string): HashSite[] {
  const sites: HashSite[] = [];
  const structs = firstFields(src);
  const CALL = 'persistentHash';
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${CALL}<`, from);
    if (at === -1) break;
    const lt = at + CALL.length;
    const gt = closingIndex(src, lt, '<', '>');
    const type = src.slice(lt + 1, gt).trim();
    const openParen = src.indexOf('(', gt);
    const args = src.slice(openParen + 1, closingIndex(src, openParen, '(', ')'));
    from = at + CALL.length;

    if (type.startsWith('Vector<')) {
      // An array literal — the domain is its first element.
      const lead = /^\s*\[\s*pad\(32,\s*"([^"]+)"\s*\)/.exec(args);
      sites.push({ type, domain: lead?.[1] ?? null });
      continue;
    }
    // A struct — its FIRST DECLARED field must be the domain, and the
    // literal must give that field a constant. Literal order is irrelevant
    // to the encoding, declaration order is not.
    const first = structs.get(type);
    if (first !== 'domain: Bytes<32>') {
      sites.push({ type, domain: null });
      continue;
    }
    const assigned = /\bdomain:\s*pad\(32,\s*"([^"]+)"\s*\)/.exec(args);
    sites.push({ type, domain: assigned?.[1] ?? null });
  }
  return sites;
}

const SOURCES = readdirSync(CONTRACTS_DIR)
  .filter((f) => f.endsWith('.compact'))
  .sort()
  .map((name) => ({ name, sites: hashSites(stripComments(readFileSync(join(CONTRACTS_DIR, name), 'utf8'))) }));

describe('hash domain separation', () => {
  it('covers every contract, and the file list has not drifted', () => {
    expect(SOURCES.map((s) => s.name)).toEqual(Object.keys(EXPECTED_HASH_SITES));
  });

  for (const { name, sites } of SOURCES) {
    it(`${name} — every hashed value leads with a domain constant`, () => {
      const undomained = sites.filter((s) => s.domain === null).map((s) => s.type);
      expect(undomained).toEqual([]);
    });

    it(`${name} — no two hashed values share a domain`, () => {
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const site of sites) {
        if (site.domain === null) continue;
        const prior = seen.get(site.domain);
        if (prior !== undefined) clashes.push(`${site.domain}: ${prior} and ${site.type}`);
        else seen.set(site.domain, site.type);
      }
      expect(clashes).toEqual([]);
    });

    it(`${name} — the reader found all ${EXPECTED_HASH_SITES[name]} hashed values`, () => {
      // Without this, a reader that matched nothing would satisfy both
      // assertions above vacuously — the same failure mode the payment
      // surface guard pins its own total against.
      expect(sites.length).toBe(EXPECTED_HASH_SITES[name]);
    });
  }
});
