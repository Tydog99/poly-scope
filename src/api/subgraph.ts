/**
 * The Graph Subgraph Client for Polymarket on-chain data
 *
 * Queries the Polymarket subgraph for account history, trades, and positions
 * directly from the Polygon blockchain.
 */

import type { SubgraphAccount, SubgraphTrade, SubgraphPosition } from './types.js';

const DEFAULT_SUBGRAPH_ID = '81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC';

export interface SubgraphClientOptions {
  subgraphId?: string;
  timeout?: number;
  retries?: number;
}

export interface TradeQueryOptions {
  limit?: number;
  before?: Date;
  after?: Date;
  orderDirection?: 'asc' | 'desc';
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class SubgraphClient {
  private endpoint: string;
  private apiKey: string;
  private timeout: number;
  private retries: number;

  constructor(apiKey: string, options: SubgraphClientOptions = {}) {
    const subgraphId = options.subgraphId || DEFAULT_SUBGRAPH_ID;
    this.endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
    this.apiKey = apiKey;
    this.timeout = options.timeout || 30000;
    this.retries = options.retries || 2;
  }

  /**
   * Execute a GraphQL query against the subgraph
   */
  private async query<T>(
    graphql: string,
    variables?: Record<string, unknown>
  ): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ query: graphql, variables }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const json = (await response.json()) as GraphQLResponse<T>;

        if (json.errors && json.errors.length > 0) {
          // Check if it's an indexer availability error (retryable)
          const isIndexerError = json.errors.some(
            (e) => e.message.includes('bad indexers') || e.message.includes('Timeout')
          );
          if (isIndexerError && attempt < this.retries) {
            lastError = new Error(json.errors[0].message);
            continue;
          }
          throw new Error(json.errors[0].message);
        }

        return json.data || null;
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.retries) {
          // Wait before retry with exponential backoff
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error('Query failed');
  }

  /**
   * Get account data for a single wallet
   */
  async getAccount(wallet: string): Promise<SubgraphAccount | null> {
    const normalizedWallet = wallet.toLowerCase();

    const result = await this.query<{ account: RawAccount | null }>(`
      query($id: ID!) {
        account(id: $id) {
          id
          creationTimestamp
          lastSeenTimestamp
          collateralVolume
          numTrades
          profit
          scaledProfit
        }
      }
    `, { id: normalizedWallet });

    if (!result?.account) {
      return null;
    }

    return this.mapAccount(result.account);
  }

  /**
   * Get account data for multiple wallets in a single query
   */
  async getAccountBatch(wallets: string[]): Promise<Map<string, SubgraphAccount>> {
    const normalizedWallets = wallets.map((w) => w.toLowerCase());

    // Build a query with aliases for each wallet
    const fragments = normalizedWallets.map((w, i) => `
      a${i}: account(id: "${w}") {
        id
        creationTimestamp
        lastSeenTimestamp
        collateralVolume
        numTrades
        profit
        scaledProfit
      }
    `);

    const result = await this.query<Record<string, RawAccount | null>>(`
      query {
        ${fragments.join('\n')}
      }
    `);

    const accounts = new Map<string, SubgraphAccount>();
    if (result) {
      for (const [key, rawAccount] of Object.entries(result)) {
        if (rawAccount) {
          accounts.set(rawAccount.id, this.mapAccount(rawAccount));
        }
      }
    }

    return accounts;
  }

  /**
   * Get trades for a wallet (as maker or taker)
   */
  async getTradesByWallet(
    wallet: string,
    options: TradeQueryOptions = {}
  ): Promise<SubgraphTrade[]> {
    const normalizedWallet = wallet.toLowerCase();
    const limit = options.limit || 100;
    const orderDirection = options.orderDirection || 'desc';

    // Build time filters
    const timeFilters: string[] = [];
    if (options.after) {
      timeFilters.push(`timestamp_gte: "${Math.floor(options.after.getTime() / 1000)}"`);
    }
    if (options.before) {
      timeFilters.push(`timestamp_lte: "${Math.floor(options.before.getTime() / 1000)}"`);
    }
    const timeFilter = timeFilters.length > 0 ? `, ${timeFilters.join(', ')}` : '';

    // Query maker trades
    const makerResult = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query($wallet: String!, $limit: Int!) {
        enrichedOrderFilleds(
          first: $limit,
          where: { maker_: { id: $wallet }${timeFilter} }
          orderBy: timestamp
          orderDirection: ${orderDirection}
        ) {
          id
          transactionHash
          timestamp
          maker { id }
          taker { id }
          market { id }
          side
          size
          price
        }
      }
    `, { wallet: normalizedWallet, limit });

    // Query taker trades
    const takerResult = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query($wallet: String!, $limit: Int!) {
        enrichedOrderFilleds(
          first: $limit,
          where: { taker_: { id: $wallet }${timeFilter} }
          orderBy: timestamp
          orderDirection: ${orderDirection}
        ) {
          id
          transactionHash
          timestamp
          maker { id }
          taker { id }
          market { id }
          side
          size
          price
        }
      }
    `, { wallet: normalizedWallet, limit });

    // Combine and deduplicate
    const tradesMap = new Map<string, SubgraphTrade>();

    for (const raw of makerResult?.enrichedOrderFilleds || []) {
      tradesMap.set(raw.id, this.mapTrade(raw));
    }
    for (const raw of takerResult?.enrichedOrderFilleds || []) {
      tradesMap.set(raw.id, this.mapTrade(raw));
    }

    // Sort by timestamp
    const trades = [...tradesMap.values()];
    trades.sort((a, b) => {
      const diff = a.timestamp - b.timestamp;
      return orderDirection === 'desc' ? -diff : diff;
    });

    return trades.slice(0, limit);
  }

  /**
   * Get trades for a specific market (token ID / orderbook)
   * Uses pagination to fetch all trades (subgraph max is 1000 per request)
   */
  async getTradesByMarket(
    marketId: string,
    options: TradeQueryOptions = {}
  ): Promise<SubgraphTrade[]> {
    const maxTotal = options.limit || 10000;
    const orderDirection = options.orderDirection || 'desc';
    const pageSize = 1000; // Subgraph max per request

    // Build time filters
    const timeFilters: string[] = [];
    if (options.after) {
      timeFilters.push(`timestamp_gte: "${Math.floor(options.after.getTime() / 1000)}"`);
    }
    if (options.before) {
      timeFilters.push(`timestamp_lte: "${Math.floor(options.before.getTime() / 1000)}"`);
    }
    const timeFilter = timeFilters.length > 0 ? `, ${timeFilters.join(', ')}` : '';

    const allTrades: SubgraphTrade[] = [];
    let skip = 0;

    while (allTrades.length < maxTotal) {
      const result = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
        query($marketId: String!, $first: Int!, $skip: Int!) {
          enrichedOrderFilleds(
            first: $first,
            skip: $skip,
            where: { market: $marketId${timeFilter} }
            orderBy: timestamp
            orderDirection: ${orderDirection}
          ) {
            id
            transactionHash
            timestamp
            maker { id }
            taker { id }
            market { id }
            side
            size
            price
          }
        }
      `, { marketId: marketId.toLowerCase(), first: pageSize, skip });

      const trades = (result?.enrichedOrderFilleds || []).map((t) => this.mapTrade(t));

      if (trades.length === 0) break; // No more trades

      allTrades.push(...trades);
      skip += pageSize;

      if (trades.length < pageSize) break; // Last page

      // Log progress for large fetches
      if (allTrades.length >= 1000 && allTrades.length % 2000 === 0) {
        console.log(`  Fetched ${allTrades.length} trades from subgraph...`);
      }
    }

    return allTrades.slice(0, maxTotal);
  }

  /**
   * Get trades for a condition (both YES and NO token IDs)
   * Polymarket conditions have 2 tokens that can be traded
   */
  async getTradesByCondition(
    yesTokenId: string,
    noTokenId: string,
    options: TradeQueryOptions = {}
  ): Promise<{ yes: SubgraphTrade[]; no: SubgraphTrade[] }> {
    const [yesTrades, noTrades] = await Promise.all([
      this.getTradesByMarket(yesTokenId, options),
      this.getTradesByMarket(noTokenId, options),
    ]);

    return { yes: yesTrades, no: noTrades };
  }

  /**
   * Get trades within a time range
   */
  async getTradesByTimeRange(
    start: Date,
    end: Date,
    options: Omit<TradeQueryOptions, 'before' | 'after'> = {}
  ): Promise<SubgraphTrade[]> {
    const limit = options.limit || 1000;
    const orderDirection = options.orderDirection || 'asc';

    const startTs = Math.floor(start.getTime() / 1000);
    const endTs = Math.floor(end.getTime() / 1000);

    const result = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query($start: BigInt!, $end: BigInt!, $limit: Int!) {
        enrichedOrderFilleds(
          first: $limit,
          where: { timestamp_gte: $start, timestamp_lte: $end }
          orderBy: timestamp
          orderDirection: ${orderDirection}
        ) {
          id
          transactionHash
          timestamp
          maker { id }
          taker { id }
          market { id }
          side
          size
          price
        }
      }
    `, { start: startTs.toString(), end: endTs.toString(), limit });

    return (result?.enrichedOrderFilleds || []).map((t) => this.mapTrade(t));
  }

  /**
   * Get trades matching a specific size (in USD)
   */
  async getTradesBySize(
    minUsd: number,
    maxUsd: number,
    options: TradeQueryOptions = {}
  ): Promise<SubgraphTrade[]> {
    const limit = options.limit || 100;
    const orderDirection = options.orderDirection || 'desc';

    // Convert USD to 6 decimal BigInt strings
    const minSize = Math.floor(minUsd * 1e6).toString();
    const maxSize = Math.floor(maxUsd * 1e6).toString();

    const result = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query($min: BigInt!, $max: BigInt!, $limit: Int!) {
        enrichedOrderFilleds(
          first: $limit,
          where: { size_gte: $min, size_lte: $max }
          orderBy: timestamp
          orderDirection: ${orderDirection}
        ) {
          id
          transactionHash
          timestamp
          maker { id }
          taker { id }
          market { id }
          side
          size
          price
        }
      }
    `, { min: minSize, max: maxSize, limit });

    return (result?.enrichedOrderFilleds || []).map((t) => this.mapTrade(t));
  }

  /**
   * Get market positions for a wallet
   */
  async getPositions(wallet: string): Promise<SubgraphPosition[]> {
    const normalizedWallet = wallet.toLowerCase();

    const result = await this.query<{ marketPositions: RawPosition[] }>(`
      query($user: String!) {
        marketPositions(
          first: 100,
          where: { user_: { id: $user } }
          orderBy: valueBought
          orderDirection: desc
        ) {
          id
          market { id }
          valueBought
          valueSold
          netValue
          quantityBought
          quantitySold
          netQuantity
        }
      }
    `, { user: normalizedWallet });

    return (result?.marketPositions || []).map((p) => this.mapPosition(p));
  }

  // --- Mapping helpers ---

  private mapAccount(raw: RawAccount): SubgraphAccount {
    return {
      id: raw.id,
      creationTimestamp: parseInt(raw.creationTimestamp),
      lastSeenTimestamp: parseInt(raw.lastSeenTimestamp),
      collateralVolume: raw.collateralVolume,
      numTrades: parseInt(raw.numTrades),
      profit: raw.profit,
      scaledProfit: raw.scaledProfit,
    };
  }

  private mapTrade(raw: RawTrade): SubgraphTrade {
    return {
      id: raw.id,
      transactionHash: raw.transactionHash,
      timestamp: parseInt(raw.timestamp),
      maker: raw.maker?.id || '',
      taker: raw.taker?.id || '',
      marketId: raw.market?.id || '',
      side: raw.side as 'Buy' | 'Sell',
      size: raw.size,
      price: raw.price,
    };
  }

  private mapPosition(raw: RawPosition): SubgraphPosition {
    return {
      id: raw.id,
      marketId: raw.market?.id || '',
      valueBought: raw.valueBought,
      valueSold: raw.valueSold,
      netValue: raw.netValue,
      quantityBought: raw.quantityBought,
      quantitySold: raw.quantitySold,
      netQuantity: raw.netQuantity,
    };
  }
}

// Raw types from GraphQL responses
interface RawAccount {
  id: string;
  creationTimestamp: string;
  lastSeenTimestamp: string;
  collateralVolume: string;
  numTrades: string;
  profit: string;
  scaledProfit: string;
}

interface RawTrade {
  id: string;
  transactionHash: string;
  timestamp: string;
  maker?: { id: string };
  taker?: { id: string };
  market?: { id: string };
  side: string;
  size: string;
  price: string;
}

interface RawPosition {
  id: string;
  market?: { id: string };
  valueBought: string;
  valueSold: string;
  netValue: string;
  quantityBought: string;
  quantitySold: string;
  netQuantity: string;
}

/**
 * Create a SubgraphClient from environment variable
 */
export function createSubgraphClient(
  options?: SubgraphClientOptions
): SubgraphClient | null {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new SubgraphClient(apiKey, options);
}
