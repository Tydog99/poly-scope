import type { TradeDB, DBPricePoint } from '../db/index.js';

const CLOB_ENDPOINT = 'https://clob.polymarket.com';

interface CLOBPricePoint {
  t: number;  // Unix timestamp
  p: number;  // Price (0-1)
}

interface CLOBPriceResponse {
  history: CLOBPricePoint[];
}

export class PriceFetcher {
  constructor(private db?: TradeDB) {}

  /**
   * Fetch prices directly from CLOB API.
   * Returns empty array on error (graceful degradation).
   */
  async fetchFromApi(
    tokenId: string,
    startTs: number,
    endTs: number
  ): Promise<DBPricePoint[]> {
    try {
      const url = new URL(`${CLOB_ENDPOINT}/prices-history`);
      url.searchParams.set('market', tokenId);
      url.searchParams.set('startTs', startTs.toString());
      url.searchParams.set('endTs', endTs.toString());

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.warn(`Price API error: HTTP ${response.status}`);
        return [];
      }

      const data = await response.json() as CLOBPriceResponse;
      return data.history.map(p => ({
        timestamp: p.t,
        price: p.p,
      }));
    } catch (error) {
      console.warn(`Price API error: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Get prices for a token, using DB cache when available.
   * Fetches missing ranges from API and saves to DB.
   */
  async getPricesForToken(
    tokenId: string,
    startTs: number,
    endTs: number
  ): Promise<DBPricePoint[]> {
    if (!this.db) {
      return this.fetchFromApi(tokenId, startTs, endTs);
    }

    // Check cache coverage
    const sync = this.db.getPriceSyncStatus(tokenId);
    const hasCoverage = sync.syncedFrom !== undefined &&
      sync.syncedTo !== undefined &&
      sync.syncedFrom <= startTs &&
      sync.syncedTo >= endTs;

    if (hasCoverage) {
      return this.db.getPricesForToken(tokenId, startTs, endTs);
    }

    // Fetch from API and cache
    const prices = await this.fetchFromApi(tokenId, startTs, endTs);
    if (prices.length > 0) {
      this.db.savePrices(tokenId, prices);
    }

    return prices;
  }

  /**
   * Batch fetch prices for multiple tokens.
   * Returns Map of tokenId -> prices.
   */
  async getPricesForMarket(
    tokenIds: string[],
    startTs: number,
    endTs: number
  ): Promise<Map<string, DBPricePoint[]>> {
    const result = new Map<string, DBPricePoint[]>();

    // Fetch in parallel
    const promises = tokenIds.map(async tokenId => {
      const prices = await this.getPricesForToken(tokenId, startTs, endTs);
      result.set(tokenId, prices);
    });

    await Promise.all(promises);
    return result;
  }
}
