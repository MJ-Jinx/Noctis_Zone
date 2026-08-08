/**
 * chain-backends.ts — concrete providers for `ChainProviderRouter`.
 *
 * Two backends today: Blockfrost (primary, wraps the existing typed client) and
 * Koios (free, no API key). Both normalise to the router's shared shapes so a
 * caller cannot tell which one answered — see `chain-provider-router.ts` for
 * why that consistency is load-bearing rather than cosmetic.
 *
 * EVERY Koios response shape below was verified against the live preprod API
 * (https://preprod.koios.rest/api/v1) on 2026-08-02, not recalled:
 *   /tip            -> abs_slot, block_height, block_no, block_time, epoch_no,
 *                      epoch_slot, era, hash
 *   /address_info   -> address, balance, script_address, stake_address, utxo_set
 *   /address_utxos  -> tx_hash, tx_index, value, asset_list, block_height,
 *                      block_time, epoch_no, payment_cred, stake_address, ...
 *   /address_txs    -> tx_hash, block_height, block_time, epoch_no
 * The `asset_list` element shape (policy_id / asset_name / quantity) matches
 * what `koios-client.php` already relies on in production.
 *
 * MAESTRO IS NOT IMPLEMENTED. The documented desired order is
 * Blockfrost -> Maestro -> Koios; Maestro needs an API key nobody has
 * provisioned, so it is simply absent rather than stubbed. Adding it later is a
 * new `ChainBackend` and one entry in the router's constructor array.
 */

import type { BlockfrostClient } from './blockfrost-client.js';
import type {
  ChainBackend,
  ChainMethod,
  RouterAddressInfo,
  RouterAddressTransaction,
  RouterAddressUtxo,
  RouterBlockInfo,
} from './chain-provider-router.js';

// ============================================================================
// BLOCKFROST
// ============================================================================

/**
 * Wraps the existing `BlockfrostClient`. Supports every routed method, so its
 * `unsupportedMethods` set is empty.
 */
export class BlockfrostBackend implements ChainBackend {
  readonly name = 'blockfrost';
  readonly unsupportedMethods: ReadonlySet<ChainMethod> = new Set();

  constructor(private readonly client: BlockfrostClient) {}

  async getLatestBlock(): Promise<RouterBlockInfo> {
    const b = await this.client.getLatestBlock();
    return { height: b.height, epoch: b.epoch, slot: b.slot, hash: b.hash };
  }

  async getAddressInfo(address: string): Promise<RouterAddressInfo> {
    const a = await this.client.getAddress(address);
    return { address: a.address, stakeAddress: a.stake_address };
  }

  async getAddressUtxosAll(address: string): Promise<RouterAddressUtxo[]> {
    const utxos = await this.client.getAddressUtxosAll(address);
    return utxos.map((u) => ({
      txHash: u.tx_hash,
      // Blockfrost exposes both; output_index is the authoritative one for a UTxO ref.
      outputIndex: u.output_index,
      amount: u.amount,
    }));
  }

  async getAddressTransactionsAll(address: string): Promise<RouterAddressTransaction[]> {
    const txs = await this.client.getAddressTransactionsAll(address);
    return txs.map((t) => ({
      txHash: t.tx_hash,
      blockHeight: t.block_height,
      blockTime: t.block_time,
    }));
  }
}

// ============================================================================
// KOIOS
// ============================================================================

export type KoiosNetwork = 'mainnet' | 'preprod' | 'preview';

const KOIOS_BASE_URLS: Record<KoiosNetwork, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
};

/** Koios caps a page at 1000 rows; paginate with offset until a short page. */
const KOIOS_PAGE_SIZE = 1000;

interface KoiosTipRow {
  hash: string;
  block_no: number;
  abs_slot: number;
  epoch_no: number;
}

interface KoiosAddressInfoRow {
  address: string;
  stake_address: string | null;
}

interface KoiosAssetListEntry {
  policy_id: string;
  asset_name: string | null;
  quantity: string;
}

interface KoiosAddressUtxoRow {
  tx_hash: string;
  tx_index: number | string;
  value: string;
  asset_list?: KoiosAssetListEntry[] | null;
}

interface KoiosAddressTxRow {
  tx_hash: string;
  block_height: number | string;
  block_time: number | string;
}

/** Koios returns some numerics as strings depending on endpoint; normalise. */
function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number.parseInt(v, 10);
}

export class KoiosBackend implements ChainBackend {
  readonly name = 'koios';

  /**
   * Koios serves all four routed methods, so nothing is declared unsupported.
   * If a method is ever added to `ChainMethod` that Koios cannot serve, add it
   * here rather than letting it throw — a thrown error would trip the circuit
   * breaker and take Koios out for the methods it CAN serve.
   */
  readonly unsupportedMethods: ReadonlySet<ChainMethod> = new Set();

  /**
   * Koios reflects the tip slightly behind a dedicated indexer under load, and
   * its account-level views expose currently-unspent state. It is a correct but
   * second-choice source for historical reads, so it is de-prioritised there
   * rather than excluded.
   */
  readonly laggy = true;

  private readonly baseUrl: string;

  constructor(network: KoiosNetwork = 'preprod', baseUrlOverride?: string) {
    this.baseUrl = baseUrlOverride ?? KOIOS_BASE_URLS[network];
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Koios ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Koios ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async getLatestBlock(): Promise<RouterBlockInfo> {
    const rows = await this.get<KoiosTipRow[]>('/tip');
    const tip = rows?.[0];
    if (!tip) throw new Error('Koios /tip returned no rows');
    return {
      height: toNumber(tip.block_no),
      epoch: toNumber(tip.epoch_no),
      // Koios reports absolute slot; Blockfrost's `slot` is also absolute.
      slot: toNumber(tip.abs_slot),
      hash: tip.hash,
    };
  }

  async getAddressInfo(address: string): Promise<RouterAddressInfo> {
    const rows = await this.post<KoiosAddressInfoRow[]>('/address_info', {
      _addresses: [address],
    });
    const row = rows?.[0];
    if (!row) {
      // An address with no on-chain history returns zero rows. That is a real
      // answer, not a provider failure — surface it as such so the router does
      // not fail over and ask a second provider the same question.
      return { address, stakeAddress: null };
    }
    return { address: row.address, stakeAddress: row.stake_address ?? null };
  }

  async getAddressUtxosAll(address: string): Promise<RouterAddressUtxo[]> {
    const out: RouterAddressUtxo[] = [];
    let offset = 0;
    for (;;) {
      const rows = await this.post<KoiosAddressUtxoRow[]>(`/address_utxos?offset=${offset}&limit=${KOIOS_PAGE_SIZE}`, {
        _addresses: [address],
        _extended: false,
      });
      for (const r of rows) {
        const amount: Array<{ unit: string; quantity: string }> = [{ unit: 'lovelace', quantity: r.value }];
        for (const a of r.asset_list ?? []) {
          // Blockfrost's `unit` is policyId ++ hex(assetName); Koios splits them.
          amount.push({ unit: `${a.policy_id}${a.asset_name ?? ''}`, quantity: a.quantity });
        }
        out.push({ txHash: r.tx_hash, outputIndex: toNumber(r.tx_index), amount });
      }
      if (rows.length < KOIOS_PAGE_SIZE) break;
      offset += KOIOS_PAGE_SIZE;
    }
    return out;
  }

  async getAddressTransactionsAll(address: string): Promise<RouterAddressTransaction[]> {
    const out: RouterAddressTransaction[] = [];
    let offset = 0;
    for (;;) {
      const rows = await this.post<KoiosAddressTxRow[]>(`/address_txs?offset=${offset}&limit=${KOIOS_PAGE_SIZE}`, {
        _addresses: [address],
        _after_block_height: 0,
      });
      for (const r of rows) {
        out.push({
          txHash: r.tx_hash,
          blockHeight: toNumber(r.block_height),
          blockTime: toNumber(r.block_time),
        });
      }
      if (rows.length < KOIOS_PAGE_SIZE) break;
      offset += KOIOS_PAGE_SIZE;
    }
    return out;
  }
}
