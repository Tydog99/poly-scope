import type { AccountHistory } from '../signals/types.js';
import { loadCredentials, createL2Headers, type ApiCredentials } from './auth.js';

const CLOB_HOST = 'https://clob.polymarket.com';

interface RawAccountTrade {
  timestamp: string;
  size: string;
  price: string;
}

export class AccountFetcher {
  private creds: ApiCredentials;

  constructor() {
    this.creds = loadCredentials();
  }

  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    const url = new URL(`${CLOB_HOST}/trades`);
    url.searchParams.set('maker_address', wallet);

    const path = url.pathname + url.search;
    const headers = createL2Headers(this.creds, 'GET', path);

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to fetch account history: ${response.statusText} - ${body}`);
    }

    const data = await response.json() as { data: RawAccountTrade[] };
    const trades = data.data;

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
