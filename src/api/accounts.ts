import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import type { AccountHistory } from '../signals/types.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

interface RawAccountTrade {
  timestamp: string;
  size: string;
  price: string;
}

export class AccountFetcher {
  private client: ClobClient;

  constructor() {
    const privateKey = process.env.POLY_PRIVATE_KEY;
    const apiKey = process.env.POLY_API_KEY;
    const secret = process.env.POLY_API_SECRET;
    const passphrase = process.env.POLY_PASSPHRASE;

    if (!privateKey || !apiKey || !secret || !passphrase) {
      throw new Error(
        'Missing credentials. Set POLY_PRIVATE_KEY, POLY_API_KEY, POLY_API_SECRET, and POLY_PASSPHRASE.\n' +
        'Run: npx tsx scripts/get-api-keys.ts --private-key 0x...'
      );
    }

    const signer = new Wallet(privateKey);
    this.client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, {
      key: apiKey,
      secret,
      passphrase,
    });
  }

  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    const trades = await this.client.getTrades({ maker_address: wallet }) as unknown as RawAccountTrade[];

    if (trades.length === 0) {
      return {
        wallet,
        totalTrades: 0,
        firstTradeDate: null,
        lastTradeDate: null,
        totalVolumeUsd: 0,
      };
    }

    const timestamps = trades.map(t => parseInt(t.timestamp) * 1000);
    const volumes = trades.map(t => parseFloat(t.size) * parseFloat(t.price));

    return {
      wallet,
      totalTrades: trades.length,
      firstTradeDate: new Date(Math.min(...timestamps)),
      lastTradeDate: new Date(Math.max(...timestamps)),
      totalVolumeUsd: volumes.reduce((sum, v) => sum + v, 0),
    };
  }
}
