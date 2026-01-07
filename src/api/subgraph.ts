/**
 * The Graph Subgraph Client for Polymarket on-chain data
 *
 * Queries the Polymarket subgraph for account history, trades, and positions
 * directly from the Polygon blockchain.
 */

import type { SubgraphAccount, SubgraphTrade, SubgraphPosition, SubgraphRedemption } from './types.js';

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
  marketIds?: string[]; // Filter to specific token IDs (e.g., YES and NO tokens for a condition)
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
          const errorText = await response.text();
          const error = new Error(`HTTP ${response.status}: ${errorText}`);

          // Check for rate limiting
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            console.log(`        [RATE LIMITED] HTTP 429 - Too Many Requests`);
            if (retryAfter) {
              console.log(`        Retry-After: ${retryAfter} seconds`);
            }
            console.log(`        Consider waiting or reducing request frequency`);
          }

          if (attempt < this.retries) {
            const waitTime = response.status === 429 ? 5000 * (attempt + 1) : 1000 * (attempt + 1);
            console.log(`        [Retry ${attempt + 1}/${this.retries}] HTTP error: ${response.status} (waiting ${waitTime}ms)`);
            lastError = error;
            await new Promise((r) => setTimeout(r, waitTime));
            continue;
          }
          throw error;
        }

        const json = (await response.json()) as GraphQLResponse<T>;

        if (json.errors && json.errors.length > 0) {
          const errorMsg = json.errors[0].message;

          // Check for rate limiting in GraphQL errors
          const isRateLimited = json.errors.some(
            (e) =>
              e.message.includes('rate limit') ||
              e.message.includes('too many requests') ||
              e.message.includes('quota exceeded') ||
              e.message.includes('throttl')
          );
          if (isRateLimited) {
            console.log(`        [RATE LIMITED] ${errorMsg.slice(0, 100)}`);
          }

          // Check if it's an indexer availability error (retryable)
          const isIndexerError = json.errors.some(
            (e) =>
              e.message.includes('bad indexers') ||
              e.message.includes('Timeout') ||
              e.message.includes('indexer') ||
              e.message.includes('Service Unavailable')
          );

          const isRetryable = isIndexerError || isRateLimited;
          if (isRetryable && attempt < this.retries) {
            // Extract useful info from error message
            const shortError = errorMsg.length > 100 ? errorMsg.slice(0, 100) + '...' : errorMsg;
            const waitTime = isRateLimited ? 5000 * (attempt + 1) : 2000 * (attempt + 1);
            console.log(`        [Retry ${attempt + 1}/${this.retries}] ${isRateLimited ? 'Rate limited' : 'Indexer error'}: ${shortError}`);
            lastError = new Error(errorMsg);
            await new Promise((r) => setTimeout(r, waitTime));
            continue;
          }
          throw new Error(errorMsg);
        }

        return json.data || null;
      } catch (error) {
        lastError = error as Error;
        const isAbort = (error as Error).name === 'AbortError';
        if (attempt < this.retries) {
          if (isAbort) {
            console.log(`        [Retry ${attempt + 1}/${this.retries}] Request timeout (${this.timeout}ms)`);
          } else {
            const shortError = lastError.message.length > 80 ? lastError.message.slice(0, 80) + '...' : lastError.message;
            console.log(`        [Retry ${attempt + 1}/${this.retries}] Error: ${shortError}`);
          }
          // On final retry attempt, log the query for debugging
          if (attempt === this.retries - 1) {
            console.log(`        Query that failed (first 500 chars):`);
            console.log(`        ${graphql.slice(0, 500).replace(/\n/g, ' ')}...`);
          }
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

    // Build variables
    const variables: Record<string, unknown> = {
      wallet: normalizedWallet,
      limit,
    };

    if (options.after) {
      variables.after = Math.floor(options.after.getTime() / 1000).toString();
    }
    if (options.before) {
      variables.before = Math.floor(options.before.getTime() / 1000).toString();
    }

    // Normalize market IDs if provided
    const marketIds = options.marketIds?.map((id) => id.toLowerCase());
    if (marketIds && marketIds.length > 0) {
      variables.marketIds = marketIds;
    }

    // Helper to build where clause string with placeholders replaced by variables
    const buildWhere = (baseWhere: string) => {
      let clause = baseWhere;
      if (variables.after) clause += `, timestamp_gte: $after`;
      if (variables.before) clause += `, timestamp_lte: $before`;
      if (variables.marketIds) clause += `, market_in: $marketIds`;
      return clause;
    };

    // Build variable declarations for GraphQL query
    const varDeclarations = [
      '$wallet: String!',
      '$limit: Int!',
      ...(variables.after ? ['$after: BigInt!'] : []),
      ...(variables.before ? ['$before: BigInt!'] : []),
      ...(variables.marketIds ? ['$marketIds: [String!]!'] : []),
    ].join(', ');

    // Query maker trades
    const makerResult = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query(${varDeclarations}) {
        enrichedOrderFilleds(
          first: $limit,
          where: { maker_: { id: $wallet }${buildWhere(' ')} }
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
    `, variables);

    // Query taker trades
    const takerResult = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
      query(${varDeclarations}) {
        enrichedOrderFilleds(
          first: $limit,
          where: { taker_: { id: $wallet }${buildWhere(' ')} }
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
    `, variables);

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

    const allTrades: SubgraphTrade[] = [];
    let lastTimestamp: string | null = null;
    let lastId: string | null = null;

    // Base variables for the query
    const variables: Record<string, unknown> = {
      marketId: marketId.toLowerCase(),
      first: pageSize,
    };

    if (options.after) {
      variables.after = Math.floor(options.after.getTime() / 1000).toString();
    }
    if (options.before) {
      variables.before = Math.floor(options.before.getTime() / 1000).toString();
    }

    while (allTrades.length < maxTotal) {
      // Build the 'where' clause dynamically
      let whereClause = 'market: $marketId';
      if (variables.after) whereClause += ', timestamp_gte: $after';
      if (variables.before) whereClause += ', timestamp_lte: $before';

      if (lastTimestamp) {
        if (orderDirection === 'desc') {
          variables.lastTimestamp = lastTimestamp;
          whereClause += ', timestamp_lt: $lastTimestamp';
        } else {
          variables.lastTimestamp = lastTimestamp;
          whereClause += ', timestamp_gt: $lastTimestamp';
        }
      }

      const result = await this.query<{ enrichedOrderFilleds: RawTrade[] }>(`
        query($marketId: String!, $first: Int!${variables.after ? ', $after: BigInt!' : ''}${variables.before ? ', $before: BigInt!' : ''}${variables.lastTimestamp ? ', $lastTimestamp: BigInt!' : ''}) {
          enrichedOrderFilleds(
            first: $first,
            where: { ${whereClause} }
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
      `, variables);

      const trades = (result?.enrichedOrderFilleds || []).map((t) => this.mapTrade(t));

      if (trades.length === 0) break; // No more trades

      allTrades.push(...trades);

      // Update cursor for next page
      const lastTrade = trades[trades.length - 1];
      lastTimestamp = lastTrade.timestamp.toString();
      lastId = lastTrade.id;

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

  /**
   * Get redemptions for a wallet (payouts from resolved markets)
   */
  async getRedemptions(wallet: string): Promise<SubgraphRedemption[]> {
    const normalizedWallet = wallet.toLowerCase();

    const result = await this.query<{ redemptions: RawRedemption[] }>(`
      query($user: String!) {
        redemptions(
          first: 100,
          where: { redeemer_: { id: $user } }
          orderBy: timestamp
          orderDirection: desc
        ) {
          id
          timestamp
          payout
          condition { id }
        }
      }
    `, { user: normalizedWallet });

    return (result?.redemptions || []).map((r) => this.mapRedemption(r));
  }

  /**
   * Get redemptions for multiple wallets in a single batched query
   */
  async getRedemptionsBatch(wallets: string[]): Promise<Map<string, SubgraphRedemption[]>> {
    const results = new Map<string, SubgraphRedemption[]>();

    if (wallets.length === 0) {
      return results;
    }

    const normalizedWallets = wallets.map((w) => w.toLowerCase());

    // Chunk wallets to avoid query complexity limits
    const CHUNK_SIZE = 50;
    const chunks: string[][] = [];
    for (let i = 0; i < normalizedWallets.length; i += CHUNK_SIZE) {
      chunks.push(normalizedWallets.slice(i, i + CHUNK_SIZE));
    }

    const batchTimes: number[] = [];
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const batchStart = Date.now();

      if (chunks.length > 1) {
        const avgTime = batchTimes.length > 0
          ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
          : 0;
        const remaining = chunks.length - chunkIdx;
        const etaStr = avgTime > 0
          ? `, ~${Math.ceil((avgTime * remaining) / 1000)}s remaining`
          : '';
        const lastTimeStr = batchTimes.length > 0
          ? ` (last: ${(batchTimes[batchTimes.length - 1] / 1000).toFixed(1)}s${etaStr})`
          : '';
        console.log(`      Redemptions batch ${chunkIdx + 1}/${chunks.length} (${chunk.length} wallets)${lastTimeStr}`);
      }

      // Build aliased query fragments
      const fragments = chunk.map((w, i) => `
        r${i}: redemptions(first: 100, where: { redeemer_: { id: "${w}" } }) {
          id
          timestamp
          payout
          condition { id }
        }
      `);

      const result = await this.query<Record<string, RawRedemption[] | null>>(`
        query {
          ${fragments.join('\n')}
        }
      `);
      batchTimes.push(Date.now() - batchStart);

      if (!result) continue;

      // Map results back to wallets
      for (let i = 0; i < chunk.length; i++) {
        const wallet = chunk[i];
        const rawRedemptions = result[`r${i}`] || [];
        results.set(wallet, rawRedemptions.map((r) => this.mapRedemption(r)));
      }
    }

    return results;
  }

  /**
   * Get trade counts for multiple wallets in a single batched query.
   * Used when Account entity has invalid numTrades (e.g., 0 trades but high volume).
   * Queries actual enrichedOrderFilleds to count maker + taker trades.
   *
   * Note: Only fetches up to 50 trades per wallet since we only need to distinguish:
   * - 1 trade (very suspicious - first trade)
   * - 2-5 trades (still suspicious)
   * - 6-50 trades (decay)
   * - ≥50 trades (established, score = 0)
   *
   * @param wallets - Array of wallet addresses to query
   * @param onBatchComplete - Optional callback called after each batch with results so far (for incremental caching)
   * @returns Map of wallet address to trade count (capped at 50 per wallet)
   */
  async getTradeCountBatch(
    wallets: string[],
    onBatchComplete?: (batchResults: Map<string, { count: number; firstTimestamp: number; lastTimestamp: number }>) => void
  ): Promise<Map<string, { count: number; firstTimestamp: number; lastTimestamp: number }>> {
    const results = new Map<string, { count: number; firstTimestamp: number; lastTimestamp: number }>();

    if (wallets.length === 0) {
      return results;
    }

    const normalizedWallets = wallets.map((w) => w.toLowerCase());

    // Chunk wallets - each wallet needs 2 aliases (maker + taker), so 50 wallets = 100 aliases
    // High-volume accounts (>$100k) are filtered out upstream, so remaining wallets are smaller
    const CHUNK_SIZE = 50;
    const DELAY_BETWEEN_BATCHES_MS = 1000; // Prevent indexer overload
    const chunks: string[][] = [];
    for (let i = 0; i < normalizedWallets.length; i += CHUNK_SIZE) {
      chunks.push(normalizedWallets.slice(i, i + CHUNK_SIZE));
    }

    const batchTimes: number[] = [];
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const batchStart = Date.now();

      if (chunks.length > 1) {
        const avgTime = batchTimes.length > 0
          ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
          : 0;
        const remaining = chunks.length - chunkIdx;
        const etaStr = avgTime > 0
          ? `, ~${Math.ceil((avgTime * remaining) / 1000)}s remaining`
          : '';
        const lastTimeStr = batchTimes.length > 0
          ? ` (last: ${(batchTimes[batchTimes.length - 1] / 1000).toFixed(1)}s${etaStr})`
          : '';
        console.log(`      Trade count batch ${chunkIdx + 1}/${chunks.length} (${chunk.length} wallets)${lastTimeStr}`);
      }

      // Build aliased query fragments for maker and taker trades
      // Only fetch 30 trades per role - we just need to detect if total >= 50 (established)
      // 30 maker + 30 taker = 60 max, which is enough to detect 50+ threshold
      const fragments = chunk.flatMap((w, i) => [
        `w${i}_maker: enrichedOrderFilleds(first: 30, where: {maker: "${w}"}, orderBy: timestamp, orderDirection: asc) { id timestamp }`,
        `w${i}_taker: enrichedOrderFilleds(first: 30, where: {taker: "${w}"}, orderBy: timestamp, orderDirection: asc) { id timestamp }`,
      ]);

      // Build the query
      const queryStr = `query { ${fragments.join('\n')} }`;

      // Debug: log query details
      if (process.env.DEBUG) {
        console.log(`        Query size: ${queryStr.length} chars, ${fragments.length} fragments`);
        console.log(`        Wallets in this batch:`);
        chunk.forEach((w, i) => console.log(`          ${i}: ${w}`));
        console.log(`        Full query:\n${queryStr}`);
      }

      const result = await this.query<Record<string, Array<{ id: string; timestamp: string }> | null>>(queryStr);
      batchTimes.push(Date.now() - batchStart);

      if (!result) continue;

      // Aggregate trades per wallet
      const batchResults = new Map<string, { count: number; firstTimestamp: number; lastTimestamp: number }>();
      for (let i = 0; i < chunk.length; i++) {
        const wallet = chunk[i];
        const makerTrades = result[`w${i}_maker`] || [];
        const takerTrades = result[`w${i}_taker`] || [];

        // Deduplicate by trade ID (in case same trade appears in both)
        const tradeMap = new Map<string, number>();
        for (const t of makerTrades) {
          tradeMap.set(t.id, parseInt(t.timestamp));
        }
        for (const t of takerTrades) {
          tradeMap.set(t.id, parseInt(t.timestamp));
        }

        const timestamps = [...tradeMap.values()];
        const count = tradeMap.size;

        const data = {
          count,
          firstTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : 0,
          lastTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : 0,
        };
        results.set(wallet, data);
        batchResults.set(wallet, data);
      }

      // Call callback to allow incremental caching
      if (onBatchComplete) {
        onBatchComplete(batchResults);
      }

      // Add delay between batches to prevent indexer overload
      if (chunkIdx < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    return results;
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

  private mapRedemption(raw: RawRedemption): SubgraphRedemption {
    return {
      id: raw.id,
      timestamp: parseInt(raw.timestamp),
      payout: raw.payout,
      conditionId: raw.condition?.id || '',
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

interface RawRedemption {
  id: string;
  timestamp: string;
  payout: string;
  condition?: { id: string };
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
