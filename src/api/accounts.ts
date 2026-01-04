import type { AccountHistory } from '../signals/types.js';

const DATA_API = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  size: string;
  price: string;
  timestamp: number;
}

export class AccountFetcher {
  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    const url = new URL(`${DATA_API}/trades`);
    url.searchParams.set('user', wallet);
    url.searchParams.set('limit', '1000');

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch account history: ${response.statusText}`);
    }

    const trades = await response.json() as DataApiTrade[];

    if (trades.length === 0) {
      return {
        wallet,
        totalTrades: 0,
        firstTradeDate: null,
        lastTradeDate: null,
        totalVolumeUsd: 0,
      };
    }

    const timestamps = trades.map(t => t.timestamp);
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
