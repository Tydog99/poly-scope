import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import type { Trade } from '../signals/types.js';
import type { RawTrade } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

export class TradeFetcher {
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

  async getTradesForMarket(
    marketId: string,
    options: {
      after?: Date;
      before?: Date;
      outcome?: 'YES' | 'NO';
    } = {}
  ): Promise<Trade[]> {
    const rawTrades = await this.client.getTrades({ market: marketId }) as unknown as RawTrade[];

    const trades: Trade[] = [];
    for (const raw of rawTrades) {
      const trade = this.convertTrade(raw, marketId);

      // Apply filters
      if (options.after && trade.timestamp < options.after) continue;
      if (options.before && trade.timestamp > options.before) continue;

      trades.push(trade);
    }

    return trades;
  }

  private convertTrade(raw: RawTrade, marketId: string): Trade {
    const size = parseFloat(raw.size);
    const price = parseFloat(raw.price);

    return {
      id: raw.id,
      marketId,
      wallet: raw.taker_address,
      side: raw.side,
      outcome: 'YES', // Will be determined by asset_id mapping
      size,
      price,
      timestamp: new Date(parseInt(raw.timestamp) * 1000),
      valueUsd: size * price,
    };
  }
}
