// witnesses.ts — privileged secrets fail loudly rather than falling back.
//
// The factories take governor/creator/community secrets as OPTIONAL arguments,
// because most calls never read them. They used to substitute the user secret
// when one was missing. Six of these contracts derive their authority key from
// that witness in the CONSTRUCTOR, into a sealed field, so a deploy that simply
// omitted the argument would bind authority to the deployer permanently, and
// every later authority check would pass for the wrong person with nothing
// anywhere to indicate it.
//
// These tests pin the replacement: absent means an error naming what is
// missing, not a quieter key.

import { describe, expect, it } from 'vitest';
import {
  bondingCurveWitnesses,
  creatorEscrowWitnesses,
  ctoGovernanceWitnesses,
  eligibilityGateWitnesses,
  lpEscrowWitnesses,
  type MerkleProofEntry,
  stakingPoolWitnesses,
  type UserSecretKey,
} from '../witnesses.js';

const sk = (fill: number): UserSecretKey => ({ bytes: new Uint8Array(32).fill(fill) });
const USER = sk(1);
const OTHER = sk(2);
const NONCE = new Uint8Array(32).fill(3);
const PROOF: MerkleProofEntry[] = [];

describe('witnesses.ts — a missing privileged secret is an error, not a downgrade', () => {
  it('eligibility gate refuses to answer for a governor it was never given', () => {
    const w = eligibilityGateWitnesses(USER, PROOF, NONCE);
    expect(() => w.getGovernorSecret(undefined)).toThrow(/needs governorSk/);
  });

  it('bonding curve refuses the same', () => {
    const w = bondingCurveWitnesses(USER, PROOF, NONCE);
    expect(() => w.getGovernorSecret(undefined)).toThrow(/needs governorSk/);
  });

  it('CTO governance refuses the same', () => {
    const w = ctoGovernanceWitnesses(USER, 0n, PROOF);
    expect(() => w.getGovernorSecret(undefined)).toThrow(/needs governorSk/);
  });

  it('creator escrow refuses to answer for a community wallet it was never given', () => {
    const w = creatorEscrowWitnesses(USER, OTHER);
    expect(() => w.getCommunitySecret(undefined)).toThrow(/needs communitySk/);
  });

  it('LP escrow refuses the same', () => {
    const w = lpEscrowWitnesses(USER);
    expect(() => w.getCommunitySecret(undefined)).toThrow(/needs communitySk/);
  });

  it('staking pool refuses for both the governor and the creator', () => {
    const w = stakingPoolWitnesses(USER, PROOF, 0n, PROOF, 0n);
    expect(() => w.getGovernorSecret(undefined)).toThrow(/needs governorSk/);
    expect(() => w.getCreatorSecret(undefined)).toThrow(/needs creatorSk/);
  });

  it('names the contract, so a failure says where to pass the secret', () => {
    const w = lpEscrowWitnesses(USER);
    expect(() => w.getCommunitySecret(undefined)).toThrow(/lpEscrowWitnesses/);
  });

  it('the user secret is still answered freely — only privileged ones are gated', () => {
    const w = eligibilityGateWitnesses(USER, PROOF, NONCE);
    expect(w.getUserSecret(undefined)[1]).toBe(USER);
  });

  it('a supplied privileged secret is returned unchanged, including a deliberately wrong one', () => {
    // How an impostor-rejection test should be written: supply a different
    // secret so the CONTRACT does the rejecting, rather than omitting it and
    // having the witness layer throw for an unrelated reason.
    const w = lpEscrowWitnesses(USER, OTHER);
    expect(w.getCommunitySecret(undefined)[1]).toBe(OTHER);
  });
});
