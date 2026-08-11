// ============================================================================
// Noctis Protocol — Staking Rewards Pool real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched), matching tier-b-curve-
// action.ts's established pattern rather than one file per action.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (bigints stringified) or { error }.
// ============================================================================

import { validatorToAddress } from '@lucid-evolution/lucid';
import { buildStakingRewardSnapshot, getRewardProof } from '../staking-reward-tree-builder.js';
import { StakingSubmitter, selectPositionToUnstake } from '../staking-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
  requireTimestampMs,
} from './cli-io.js';

declare const __dirname: string;

type Action =
  | 'stake'
  | 'unstake'
  | 'claim-rewards'
  | 'top-up'
  | 'publish-reward-root'
  | 'read-pool'
  | 'read-positions'
  | 'build-reward-snapshot'
  | 'get-reward-proof';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  /** The launch's thread-NFT policy id, from WordPress's own launch record —
   *  never from a datum. Every action here reads the pool UTXO, and that read
   *  is authenticated against this. */
  threadNftPolicyId: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  // stake / unstake / claim-rewards — CLI verification path only (mnemonic)
  stakerMnemonic?: string;
  stakerAddress?: string; // read-positions

  // stake
  amount?: string; // stringified bigint
  // stake — optional backdating for real Preprod verification of the
  // 7-day bonding period without a literal 7-day wait (see staking-
  // submitter().ts's stakeCore comment for why this is safe to accept).
  stakeTimestampMs?: number;

  // unstake — identifies which of the staker's positions to close
  positionTxHash?: string;
  positionOutputIndex?: number;

  // claim-rewards / get-reward-proof
  /** What the CURRENT root pays this staker — a delta, not a running
   *  total. From the published snapshot's own entry. */
  payoutAmount?: string; // stringified bigint
  /** This staker's bit in the pool's nullifier, from the same snapshot. */
  leafIndex?: number;
  /** publish-reward-root: how many stakers the new root pays. Sizes its
   *  nullifier, one bit each — take it from the tree, never a guess. */
  entryCount?: number;
  merkleProof?: Array<{ sibling: string; goesLeft: boolean }>;
  stakerVkhHex?: string; // get-reward-proof

  // top-up / publish-reward-root — governor/creator extended-key signing
  signerPrivateKeyExtendedHex?: string;
  signerAddress?: string;
  newRootHex?: string; // publish-reward-root

  // build-reward-snapshot — governor cron job
  tokenPolicyId?: string;
  tokenAssetName?: string;
  durationDays?: number;
  bondingPeriodDays?: number;

  // get-reward-proof — the already-built snapshot's entries, re-supplied
  // by the caller (a REST route reading its own last-published snapshot),
  // not recomputed here.
  entries?: Array<{ stakerVkh: string; payoutAmount: string }>;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  requireFieldsFalsy(input, [
    'action',
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const stakingPoolScriptCbor = loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend');

  // Lazily constructed, and that ordering is the point: the submitter opens a
  // Blockfrost connection in its constructor and stores the promise, which
  // nothing awaits until a method runs. Built before the per-action field
  // checks below, a request that was never valid still opened a connection —
  // and when that connection then failed, its rejection had no awaiter, so
  // Node printed a stack trace to stderr AFTER the real {"error"} answer had
  // already gone to stdout. The output contract held; a human reading the
  // terminal saw a crash next to a correct message.
  //
  // Each case validates its own fields on their own lines before calling
  // `submitter()`, so an invalid request never reaches the network at all.
  let submitterInstance: StakingSubmitter | null = null;
  const submitter = (): StakingSubmitter =>
    (submitterInstance ??= new StakingSubmitter({
      blockfrostProjectId: input.blockfrostProjectId,
      blockfrostUrl: input.blockfrostUrl,
      network: CARDANO_NETWORK_MAP[input.network],
      stakingPoolScriptCbor,
      launchIdHex: input.launchIdHex,
      threadNftPolicyId: input.threadNftPolicyId,
    }));

  let result: unknown;
  switch (input.action) {
    case 'stake': {
      const mnemonic = requireField(input, 'stakerMnemonic', input.action);
      const amount = BigInt(requireField(input, 'amount', input.action));
      result = await submitter().stake(
        mnemonic,
        amount,
        input.stakeTimestampMs === undefined
          ? undefined
          : requireTimestampMs(input.stakeTimestampMs, 'stakeTimestampMs'),
      );
      break;
    }
    case 'unstake': {
      const mnemonic = requireField(input, 'stakerMnemonic', input.action);
      // Resolve the staker's own address the same way the submitter does internally, to locate their position(s).
      const { Lucid, Blockfrost } = await import('@lucid-evolution/lucid');
      const lucidForAddr = await Lucid(
        new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId),
        CARDANO_NETWORK_MAP[input.network],
      );
      lucidForAddr.selectWallet.fromSeed(mnemonic);
      const stakerAddress = await lucidForAddr.wallet().address();
      const positions = await submitter().findPositions(stakerAddress);
      const position = selectPositionToUnstake(positions, {
        txHash: input.positionTxHash,
        outputIndex: input.positionOutputIndex,
      });
      result = await submitter().unstake(mnemonic, position);
      break;
    }
    case 'claim-rewards': {
      const mnemonic = requireField(input, 'stakerMnemonic', input.action);
      const payoutAmount = BigInt(requireField(input, 'payoutAmount', input.action));
      const leafIndex = requireField(input, 'leafIndex', input.action);
      const merkleProof = requireField(input, 'merkleProof', input.action);
      result = await submitter().claimRewards(mnemonic, payoutAmount, leafIndex, merkleProof);
      break;
    }
    case 'top-up': {
      const key = requireField(input, 'signerPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'signerAddress', input.action);
      const amount = BigInt(requireField(input, 'amount', input.action));
      result = await submitter().topUpPool(key, addr, amount);
      break;
    }
    case 'publish-reward-root': {
      const key = requireField(input, 'signerPrivateKeyExtendedHex', input.action);
      const addr = requireField(input, 'signerAddress', input.action);
      const newRoot = requireField(input, 'newRootHex', input.action);
      const entryCount = requireField(input, 'entryCount', input.action);
      result = await submitter().publishRewardRoot(key, addr, newRoot, entryCount);
      break;
    }
    case 'read-pool': {
      result = await submitter().readPoolDatum();
      break;
    }
    case 'read-positions': {
      const stakerAddress = requireField(input, 'stakerAddress', input.action);
      result = await submitter().findPositions(stakerAddress);
      break;
    }
    case 'build-reward-snapshot': {
      const stakingPoolAddress = validatorToAddress(CARDANO_NETWORK_MAP[input.network], {
        type: 'PlutusV3',
        script: stakingPoolScriptCbor,
      });
      const tokenPolicyId = requireField(input, 'tokenPolicyId', input.action);
      const tokenAssetName = requireField(input, 'tokenAssetName', input.action);
      // Required, not optional: the genesis pool output is identified by this
      // launch's thread NFT, and the policy has to come from the caller's own
      // record rather than the datum being read.
      const durationDays = requireField(input, 'durationDays', input.action);
      const snapshot = await buildStakingRewardSnapshot(
        {
          blockfrostProjectId: input.blockfrostProjectId,
          blockfrostUrl: input.blockfrostUrl,
        },
        {
          stakingPoolAddress,
          launchIdHex: input.launchIdHex,
          tokenPolicyId,
          tokenAssetName,
          threadNftPolicyId: input.threadNftPolicyId,
          durationDays,
          bondingPeriodDays: input.bondingPeriodDays,
        },
      );
      result = {
        rootHex: Buffer.from(snapshot.tree.root).toString('hex'),
        entries: snapshot.entries.map((e) => ({
          stakerVkh: e.stakerVkh,
          payoutAmount: e.payoutAmount,
        })),
        // The cleared nullifier this root must be published with, and the
        // entry count that sizes it. Hand both to publish-reward-root.
        claimedBitsHex: snapshot.claimedBitsHex,
        entryCount: snapshot.entries.length,
        initialSeededAmount: snapshot.initialSeededAmount,
        dailyEmission: snapshot.dailyEmission,
      };
      break;
    }
    case 'get-reward-proof': {
      const stakerVkhHex = requireField(input, 'stakerVkhHex', input.action);
      const entriesRaw = requireField(input, 'entries', input.action);
      const entries = entriesRaw.map((e) => ({
        stakerVkh: e.stakerVkh,
        payoutAmount: BigInt(e.payoutAmount),
      }));
      result = getRewardProof(entries, stakerVkhHex);
      break;
    }
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
