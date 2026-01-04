import type { AccountHistory } from '../signals/types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

interface RawAccountTrade {
  timestamp: string;
  size: string;
  price: string;
}

export class AccountFetcher {
  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    const url = new URL(`${CLOB_HOST}/trades`);
    url.searchParams.set('maker_address', wallet);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch account history: ${response.statusText}`);
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
