// Tests for wallet-connection.ts — the unified Cardano (CIP-30) / Midnight
// (DApp Connector) wallet abstraction the frontend uses. Runs in Node (no
// jsdom configured for this package), so `window` is stubbed per-test via
// vi.stubGlobal and cleared in afterEach — this module only ever touches
// `window.cardano`/`window.midnight`, nothing else DOM-shaped.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', () => ({
  getAddressDetails: vi.fn(),
}));

import { getAddressDetails } from '@lucid-evolution/lucid';
import {
  type CardanoWalletConnection,
  connectCardanoWallet,
  connectMidnightWallet,
  createWalletManager,
  detectCardanoWallets,
  detectMidnightWallets,
  type MidnightWalletConnection,
  signCardanoData,
  signCardanoTx,
  submitCardanoTx,
  WalletManager,
} from '../wallet-connection.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getAddressDetails).mockReset();
});

// ============================================================================
// Cardano — detection
// ============================================================================

describe('detectCardanoWallets', () => {
  it('returns an empty array when window.cardano does not exist', () => {
    vi.stubGlobal('window', {});
    expect(detectCardanoWallets()).toEqual([]);
  });

  it('lists only entries with a callable enable() function, mapping name/icon/apiVersion with fallbacks', () => {
    vi.stubGlobal('window', {
      cardano: {
        eternl: {
          enable: () => {},
          name: 'Eternl',
          icon: 'eternl.png',
          apiVersion: '0.1.0',
        },
        nami: { enable: () => {} }, // no name/icon/apiVersion — must fall back
        notAWallet: { somethingElse: true }, // no enable() — must be excluded
      },
    });

    const wallets = detectCardanoWallets();

    expect(wallets).toHaveLength(2);
    expect(wallets).toContainEqual({
      id: 'eternl',
      name: 'Eternl',
      icon: 'eternl.png',
      version: '0.1.0',
      enabled: false,
    });
    expect(wallets).toContainEqual({
      id: 'nami',
      name: 'nami',
      icon: '',
      version: 'unknown',
      enabled: false,
    });
  });
});

// ============================================================================
// Cardano — connect
// ============================================================================

describe('connectCardanoWallet', () => {
  it('throws when window.cardano does not exist', async () => {
    vi.stubGlobal('window', {});
    await expect(connectCardanoWallet('eternl')).rejects.toThrow(/No Cardano wallet found/);
  });

  it('throws when the named wallet is not present', async () => {
    vi.stubGlobal('window', { cardano: {} });
    await expect(connectCardanoWallet('eternl')).rejects.toThrow(/"eternl" not found/);
  });

  it('decodes the CIP-30 hex change address via lucid, extracts key hashes, and maps network 1 -> mainnet', async () => {
    vi.mocked(getAddressDetails).mockImplementation((addr: string) => {
      if (addr === 'deadbeef-change') {
        return {
          address: { bech32: 'addr1qxyz' },
          paymentCredential: { hash: 'paymenthash123' },
          stakeCredential: { hash: 'stakehash123' },
        } as never;
      }
      if (addr === 'deadbeef-reward') {
        return { address: { bech32: 'stake1uxyz' } } as never;
      }
      throw new Error(`unexpected address passed to getAddressDetails: ${addr}`);
    });

    const api = {
      getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockResolvedValue(['deadbeef-reward']),
      getNetworkId: vi.fn().mockResolvedValue(1),
      getBalance: vi.fn().mockResolvedValue('5000000'),
    };
    const wallet = { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' };
    vi.stubGlobal('window', { cardano: { eternl: wallet } });

    const result = await connectCardanoWallet('eternl');

    expect(result).toEqual<CardanoWalletConnection>({
      chain: 'cardano',
      walletId: 'eternl',
      walletName: 'Eternl',
      address: 'addr1qxyz',
      paymentKeyHash: 'paymenthash123',
      stakingKeyHash: 'stakehash123',
      rewardAddressHex: 'deadbeef-reward',
      stakeAddress: 'stake1uxyz',
      networkId: 1,
      network: 'mainnet',
      balance: '5000000',
    });
  });

  it('maps any non-1 networkId to preprod', async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qxyz' },
    } as never);
    const api = {
      getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockResolvedValue([]),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
    };
    vi.stubGlobal('window', {
      cardano: {
        eternl: { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' },
      },
    });

    const result = await connectCardanoWallet('eternl');
    expect(result.network).toBe('preprod');
  });

  it('falls back to the first used address when getChangeAddress is empty', async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qused' },
    } as never);
    const api = {
      getChangeAddress: vi.fn().mockResolvedValue(''),
      getUsedAddresses: vi.fn().mockResolvedValue(['deadbeef-used']),
      getRewardAddresses: vi.fn().mockResolvedValue([]),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
    };
    vi.stubGlobal('window', {
      cardano: {
        eternl: { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' },
      },
    });

    const result = await connectCardanoWallet('eternl');
    expect(getAddressDetails).toHaveBeenCalledWith('deadbeef-used');
    expect(result.address).toBe('addr1qused');
  });

  it('throws when neither a change nor a used address is available', async () => {
    const api = {
      getChangeAddress: vi.fn().mockResolvedValue(''),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockResolvedValue([]),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
    };
    vi.stubGlobal('window', {
      cardano: {
        eternl: { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' },
      },
    });

    await expect(connectCardanoWallet('eternl')).rejects.toThrow(/No address available/);
  });

  it('leaves rewardAddressHex/stakeAddress empty (not throwing) when getRewardAddresses rejects — enterprise-address wallets', async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qxyz' },
    } as never);
    const api = {
      getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockRejectedValue(new Error('no reward addresses')),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
    };
    vi.stubGlobal('window', {
      cardano: {
        eternl: { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' },
      },
    });

    const result = await connectCardanoWallet('eternl');
    expect(result.rewardAddressHex).toBe('');
    expect(result.stakeAddress).toBe('');
  });
});

describe('signCardanoTx / submitCardanoTx / signCardanoData', () => {
  it('signCardanoTx enables the named wallet and calls signTx with the tx and partialSign flag', async () => {
    const signTx = vi.fn().mockResolvedValue('signed-cbor');
    const enable = vi.fn().mockResolvedValue({ signTx });
    vi.stubGlobal('window', { cardano: { eternl: { enable } } });

    const result = await signCardanoTx('eternl', 'unsigned-cbor', true);

    expect(enable).toHaveBeenCalledTimes(1);
    expect(signTx).toHaveBeenCalledWith('unsigned-cbor', true);
    expect(result).toBe('signed-cbor');
  });

  it('signCardanoTx defaults partialSign to false', async () => {
    const signTx = vi.fn().mockResolvedValue('signed-cbor');
    vi.stubGlobal('window', {
      cardano: { eternl: { enable: vi.fn().mockResolvedValue({ signTx }) } },
    });
    await signCardanoTx('eternl', 'unsigned-cbor');
    expect(signTx).toHaveBeenCalledWith('unsigned-cbor', false);
  });

  it('submitCardanoTx enables the named wallet and calls submitTx with the signed cbor', async () => {
    const submitTx = vi.fn().mockResolvedValue('txhash123');
    vi.stubGlobal('window', {
      cardano: { eternl: { enable: vi.fn().mockResolvedValue({ submitTx }) } },
    });
    const result = await submitCardanoTx('eternl', 'signed-cbor');
    expect(submitTx).toHaveBeenCalledWith('signed-cbor');
    expect(result).toBe('txhash123');
  });

  it('signCardanoData enables the named wallet and calls signData with address+payload', async () => {
    const signData = vi.fn().mockResolvedValue({ signature: 'sig', key: 'key' });
    vi.stubGlobal('window', {
      cardano: { eternl: { enable: vi.fn().mockResolvedValue({ signData }) } },
    });
    const result = await signCardanoData('eternl', 'addr1qxyz', 'payload-hex');
    expect(signData).toHaveBeenCalledWith('addr1qxyz', 'payload-hex');
    expect(result).toEqual({ signature: 'sig', key: 'key' });
  });

  it.each([
    ['signCardanoTx', () => signCardanoTx('missing', 'cbor')],
    ['submitCardanoTx', () => submitCardanoTx('missing', 'cbor')],
    ['signCardanoData', () => signCardanoData('missing', 'addr', 'payload')],
  ])('%s throws when the named wallet is not found', async (_name, call) => {
    vi.stubGlobal('window', { cardano: {} });
    await expect(call()).rejects.toThrow(/"missing" not found/);
  });

  it.each([
    ['signCardanoTx', () => signCardanoTx('eternl', 'cbor')],
    ['submitCardanoTx', () => submitCardanoTx('eternl', 'cbor')],
    ['signCardanoData', () => signCardanoData('eternl', 'addr', 'payload')],
  ])('%s throws when window.cardano does not exist', async (_name, call) => {
    vi.stubGlobal('window', {});
    await expect(call()).rejects.toThrow(/No Cardano wallet found/);
  });
});

// ============================================================================
// Midnight — detection
// ============================================================================

describe('detectMidnightWallets', () => {
  it('returns an empty array when window.midnight does not exist', () => {
    vi.stubGlobal('window', {});
    expect(detectMidnightWallets()).toEqual([]);
  });

  it('lists only entries with a callable connect() function, including rdns', () => {
    vi.stubGlobal('window', {
      midnight: {
        'uuid-1': {
          connect: () => {},
          rdns: 'io.lace.wallet',
          name: 'Lace',
          icon: 'lace.png',
          apiVersion: '4.0.1',
        },
        'uuid-2': { notAWallet: true },
      },
    });

    const wallets = detectMidnightWallets();

    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toEqual({
      id: 'uuid-1',
      rdns: 'io.lace.wallet',
      name: 'Lace',
      icon: 'lace.png',
      version: '4.0.1',
      enabled: false,
    });
  });
});

describe('connectMidnightWallet', () => {
  it('throws when window.midnight does not exist', async () => {
    vi.stubGlobal('window', {});
    await expect(connectMidnightWallet('uuid-1')).rejects.toThrow(/No Midnight wallet found/);
  });

  it('throws when the named wallet is not present', async () => {
    vi.stubGlobal('window', { midnight: {} });
    await expect(connectMidnightWallet('uuid-1')).rejects.toThrow(/"uuid-1" not found/);
  });

  it('connects, reads shielded/unshielded addresses, and uses the live network from getConnectionStatus when connected', async () => {
    const api = {
      getShieldedAddresses: vi.fn().mockResolvedValue({
        shieldedAddress: 'mn_shield_addr1',
        shieldedCoinPublicKey: 'mn_coin_pk1',
        shieldedEncryptionPublicKey: 'mn_enc_pk1',
      }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: 'mn_unshield_addr1' }),
      getConnectionStatus: vi.fn().mockResolvedValue({ status: 'connected', networkId: 'mainnet' }),
    };
    const wallet = {
      connect: vi.fn().mockResolvedValue(api),
      rdns: 'io.lace.wallet',
      name: 'Lace',
    };
    vi.stubGlobal('window', { midnight: { 'uuid-1': wallet } });

    const result = await connectMidnightWallet('uuid-1', 'testnet');

    expect(wallet.connect).toHaveBeenCalledWith('testnet');
    expect(result).toEqual<MidnightWalletConnection>({
      chain: 'midnight',
      walletId: 'uuid-1',
      walletRdns: 'io.lace.wallet',
      walletName: 'Lace',
      shieldedAddress: 'mn_shield_addr1',
      shieldedCoinPublicKey: 'mn_coin_pk1',
      shieldedEncryptionPublicKey: 'mn_enc_pk1',
      unshieldedAddress: 'mn_unshield_addr1',
      network: 'mainnet', // from getConnectionStatus, not the connect() hint
      api: api as never,
    });
  });

  it('falls back to the networkId hint when getConnectionStatus does not report "connected"', async () => {
    const api = {
      getShieldedAddresses: vi.fn().mockResolvedValue({
        shieldedAddress: 'a',
        shieldedCoinPublicKey: 'b',
        shieldedEncryptionPublicKey: 'c',
      }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: 'd' }),
      getConnectionStatus: vi.fn().mockResolvedValue({ status: 'disconnected' }),
    };
    vi.stubGlobal('window', {
      midnight: { 'uuid-1': { connect: vi.fn().mockResolvedValue(api) } },
    });

    const result = await connectMidnightWallet('uuid-1', 'devnet');
    expect(result.network).toBe('devnet');
  });

  it('defaults networkId hint to "testnet" when not provided', async () => {
    const connect = vi.fn().mockResolvedValue({
      getShieldedAddresses: vi.fn().mockResolvedValue({
        shieldedAddress: 'a',
        shieldedCoinPublicKey: 'b',
        shieldedEncryptionPublicKey: 'c',
      }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: 'd' }),
      getConnectionStatus: vi.fn().mockResolvedValue({ status: 'disconnected' }),
    });
    vi.stubGlobal('window', { midnight: { 'uuid-1': { connect } } });

    await connectMidnightWallet('uuid-1');
    expect(connect).toHaveBeenCalledWith('testnet');
  });
});

// ============================================================================
// WalletManager
// ============================================================================

describe('WalletManager', () => {
  it('getAvailableCardanoWallets/getAvailableMidnightWallets delegate to detect*Wallets against the current window', () => {
    vi.stubGlobal('window', {
      cardano: { eternl: { enable: () => {} } },
      midnight: { 'uuid-1': { connect: () => {} } },
    });
    const manager = new WalletManager();
    expect(manager.getAvailableCardanoWallets()).toHaveLength(1);
    expect(manager.getAvailableMidnightWallets()).toHaveLength(1);
  });

  it('isConnected reflects null-until-connected state per chain, independently', () => {
    const manager = new WalletManager();
    expect(manager.isConnected('cardano')).toBe(false);
    expect(manager.isConnected('midnight')).toBe(false);
  });

  it('connectCardano stores and returns the connection; getCardanoConnection reflects it', async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qxyz' },
    } as never);
    const api = {
      getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockResolvedValue([]),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
    };
    vi.stubGlobal('window', {
      cardano: {
        eternl: { enable: vi.fn().mockResolvedValue(api), name: 'Eternl' },
      },
    });

    const manager = new WalletManager();
    const connection = await manager.connectCardano('eternl');

    expect(manager.getCardanoConnection()).toBe(connection);
    expect(manager.isConnected('cardano')).toBe(true);
    expect(manager.isConnected('midnight')).toBe(false);
  });

  it('connectMidnight stores and returns the connection; getMidnightConnection reflects it', async () => {
    const api = {
      getShieldedAddresses: vi.fn().mockResolvedValue({
        shieldedAddress: 'a',
        shieldedCoinPublicKey: 'b',
        shieldedEncryptionPublicKey: 'c',
      }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: 'd' }),
      getConnectionStatus: vi.fn().mockResolvedValue({ status: 'connected', networkId: 'mainnet' }),
    };
    vi.stubGlobal('window', {
      midnight: { 'uuid-1': { connect: vi.fn().mockResolvedValue(api) } },
    });

    const manager = new WalletManager();
    const connection = await manager.connectMidnight('uuid-1');

    expect(manager.getMidnightConnection()).toBe(connection);
    expect(manager.isConnected('midnight')).toBe(true);
  });

  it('signAndSubmitCardanoTx throws when no Cardano wallet is connected', async () => {
    const manager = new WalletManager();
    await expect(manager.signAndSubmitCardanoTx('cbor')).rejects.toThrow(/Cardano wallet not connected/);
  });

  it("signAndSubmitCardanoTx signs then submits using the connected wallet's walletId, in order", async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qxyz' },
    } as never);
    const signTx = vi.fn().mockResolvedValue('signed-cbor');
    const submitTx = vi.fn().mockResolvedValue('txhash123');
    const enable = vi.fn().mockResolvedValue({
      getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses: vi.fn().mockResolvedValue([]),
      getNetworkId: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue('0'),
      signTx,
      submitTx,
    });
    vi.stubGlobal('window', {
      cardano: { eternl: { enable, name: 'Eternl' } },
    });

    const manager = new WalletManager();
    await manager.connectCardano('eternl');
    const txHash = await manager.signAndSubmitCardanoTx('unsigned-cbor', true);

    expect(signTx).toHaveBeenCalledWith('unsigned-cbor', true);
    expect(submitTx).toHaveBeenCalledWith('signed-cbor');
    expect(txHash).toBe('txhash123');
  });

  it('disconnectCardano/disconnectMidnight/disconnectAll clear the expected connections', async () => {
    vi.mocked(getAddressDetails).mockReturnValue({
      address: { bech32: 'addr1qxyz' },
    } as never);
    vi.stubGlobal('window', {
      cardano: {
        eternl: {
          enable: vi.fn().mockResolvedValue({
            getChangeAddress: vi.fn().mockResolvedValue('deadbeef-change'),
            getUsedAddresses: vi.fn().mockResolvedValue([]),
            getRewardAddresses: vi.fn().mockResolvedValue([]),
            getNetworkId: vi.fn().mockResolvedValue(0),
            getBalance: vi.fn().mockResolvedValue('0'),
          }),
          name: 'Eternl',
        },
      },
      midnight: {
        'uuid-1': {
          connect: vi.fn().mockResolvedValue({
            getShieldedAddresses: vi.fn().mockResolvedValue({
              shieldedAddress: 'a',
              shieldedCoinPublicKey: 'b',
              shieldedEncryptionPublicKey: 'c',
            }),
            getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: 'd' }),
            getConnectionStatus: vi.fn().mockResolvedValue({ status: 'connected', networkId: 'mainnet' }),
          }),
        },
      },
    });

    const manager = new WalletManager();
    await manager.connectCardano('eternl');
    await manager.connectMidnight('uuid-1');
    expect(manager.isConnected('cardano')).toBe(true);
    expect(manager.isConnected('midnight')).toBe(true);

    manager.disconnectCardano();
    expect(manager.isConnected('cardano')).toBe(false);
    expect(manager.isConnected('midnight')).toBe(true);

    manager.disconnectMidnight();
    expect(manager.isConnected('midnight')).toBe(false);
  });
});

describe('createWalletManager', () => {
  it('returns a fresh WalletManager instance with nothing connected', () => {
    const manager = createWalletManager();
    expect(manager).toBeInstanceOf(WalletManager);
    expect(manager.isConnected('cardano')).toBe(false);
    expect(manager.isConnected('midnight')).toBe(false);
  });
});
