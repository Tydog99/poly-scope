import type { Trade } from '../signals/types.js';
import type { RawTrade, TradeHistoryResponse } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

export class TradeFetcher {
  async getTradesForMarket(
    marketId: string,
    options: {
      after?: Date;
      before?: Date;
      outcome?: 'YES' | 'NO';
    } = {}
  ): Promise<Trade[]> {
    const allTrades: Trade[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`${CLOB_HOST}/trades`);
      url.searchParams.set('market', marketId);
      if (cursor) url.searchParams.set('next_cursor', cursor);

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.statusText}`);
      }

      const data: TradeHistoryResponse = await response.json();

      for (const raw of data.data) {
        const trade = this.convertTrade(raw, marketId);

        // Apply filters
        if (options.after && trade.timestamp < options.after) continue;
        if (options.before && trade.timestamp > options.before) continue;

        allTrades.push(trade);
      }

      cursor = data.next_cursor;
    } while (cursor);

    return allTrades;
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
