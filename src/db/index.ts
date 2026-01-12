import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { initializeSchema } from './schema.js';
import { aggregateFills } from '../api/aggregator.js';
import type { SubgraphTrade } from '../api/types.js';

export interface DBStatus {
  path: string;
  fills: number;      // renamed from 'trades'
  accounts: number;
  redemptions: number;
  markets: number;
  backfillQueue: number;
  priceHistory: number;
}

export interface DBEnrichedOrderFill {
  id: string;
  transactionHash: string;
  timestamp: number;
  orderHash: string;
  side: 'Buy' | 'Sell';
  size: number;      // 6 decimals
  price: number;     // 6 decimals
  maker: string;
  taker: string;
  market: string;
}

export interface DBAccount {
  wallet: string;
  creationTimestamp: number | null;
  syncedFrom: number | null;
  syncedTo: number | null;
  syncedAt: number | null;
  tradeCountTotal: number | null;
  collateralVolume: number | null;
  profit: number | null;
  hasFullHistory: boolean;
}

export interface PointInTimeState {
  tradeCount: number;
  volume: number;
  pnl: number;
  approximate: boolean;
}

export interface DBRedemption {
  id: string;
  wallet: string;
  conditionId: string;
  timestamp: number;
  payout: number;
}

export interface DBMarket {
  tokenId: string;
  conditionId: string | null;
  question: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  resolvedAt: number | null;
}

export interface DBMarketSync {
  tokenId: string;
  syncedFrom: number | null;
  syncedTo: number | null;
  syncedAt: number | null;
  hasCompleteHistory: boolean;
}

export interface GetFillsOptions {
  after?: number;
  before?: number;
  role?: 'maker' | 'taker' | 'both';
  limit?: number;
}

export interface BackfillQueueItem {
  wallet: string;
  priority: number;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface DBPricePoint {
  timestamp: number;
  price: number;  // 0-1 decimal
}

export interface PriceSyncStatus {
  syncedFrom?: number;
  syncedTo?: number;
}

export class TradeDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = '.data/trades.db') {
    this.dbPath = dbPath;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    initializeSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  getStatus(): DBStatus {
    const count = (table: string): number => {
      const result = this.db
        .prepare(`SELECT COUNT(*) as n FROM ${table}`)
        .get() as { n: number };
      return result.n;
    };

    return {
      path: this.dbPath,
      fills: count('enriched_order_fills'),
      accounts: count('accounts'),
      redemptions: count('redemptions'),
      markets: count('markets'),
      backfillQueue: count('backfill_queue'),
      priceHistory: count('price_history'),
    };
  }

  saveFills(fills: DBEnrichedOrderFill[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO enriched_order_fills
      (id, transaction_hash, timestamp, order_hash, side, size, price, maker, taker, market)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;

    const insertMany = this.db.transaction((fills: DBEnrichedOrderFill[]) => {
      for (const f of fills) {
        const result = stmt.run(
          f.id,
          f.transactionHash,
          f.timestamp,
          f.orderHash,
          f.side,
          f.size,
          f.price,
          f.maker.toLowerCase(),
          f.taker.toLowerCase(),
          f.market
        );
        inserted += result.changes;
      }
    });

    insertMany(fills);
    return inserted;
  }

  getFillsForWallet(
    wallet: string,
    options: GetFillsOptions = {}
  ): DBEnrichedOrderFill[] {
    const walletLower = wallet.toLowerCase();
    const role = options.role ?? 'both';

    let sql: string;
    let params: (string | number)[] = [];

    if (role === 'maker') {
      sql = `SELECT * FROM enriched_order_fills WHERE maker = ?`;
      params = [walletLower];
    } else if (role === 'taker') {
      sql = `SELECT * FROM enriched_order_fills WHERE taker = ?`;
      params = [walletLower];
    } else {
      // 'both' - wallet is either maker or taker
      sql = `SELECT * FROM enriched_order_fills WHERE maker = ? OR taker = ?`;
      params = [walletLower, walletLower];
    }

    if (options.after !== undefined) {
      sql += ' AND timestamp >= ?';
      params.push(options.after);
    }
    if (options.before !== undefined) {
      sql += ' AND timestamp < ?';
      params.push(options.before);
    }

    sql += ' ORDER BY timestamp DESC';

    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as {
      id: string;
      transaction_hash: string;
      timestamp: number;
      order_hash: string;
      side: string;
      size: number;
      price: number;
      maker: string;
      taker: string;
      market: string;
    }[];

    return rows.map(r => ({
      id: r.id,
      transactionHash: r.transaction_hash,
      timestamp: r.timestamp,
      orderHash: r.order_hash,
      side: r.side as 'Buy' | 'Sell',
      size: r.size,
      price: r.price,
      maker: r.maker,
      taker: r.taker,
      market: r.market,
    }));
  }

  getFillsForMarket(
    market: string,
    options: GetFillsOptions = {}
  ): DBEnrichedOrderFill[] {
    let sql = `SELECT * FROM enriched_order_fills WHERE market = ?`;
    const params: (string | number)[] = [market];

    if (options.after !== undefined) {
      sql += ' AND timestamp >= ?';
      params.push(options.after);
    }
    if (options.before !== undefined) {
      sql += ' AND timestamp < ?';
      params.push(options.before);
    }

    sql += ' ORDER BY timestamp DESC';

    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as {
      id: string;
      transaction_hash: string;
      timestamp: number;
      order_hash: string;
      side: string;
      size: number;
      price: number;
      maker: string;
      taker: string;
      market: string;
    }[];

    return rows.map(r => ({
      id: r.id,
      transactionHash: r.transaction_hash,
      timestamp: r.timestamp,
      orderHash: r.order_hash,
      side: r.side as 'Buy' | 'Sell',
      size: r.size,
      price: r.price,
      maker: r.maker,
      taker: r.taker,
      market: r.market,
    }));
  }

  saveAccount(account: DBAccount): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO accounts
      (wallet, creation_timestamp, synced_from, synced_to, synced_at,
       trade_count_total, collateral_volume, profit, has_full_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.wallet.toLowerCase(),
      account.creationTimestamp,
      account.syncedFrom,
      account.syncedTo,
      account.syncedAt,
      account.tradeCountTotal,
      account.collateralVolume,
      account.profit,
      account.hasFullHistory ? 1 : 0
    );
  }

  getAccount(wallet: string): DBAccount | null {
    const row = this.db.prepare(`
      SELECT wallet, creation_timestamp as creationTimestamp,
             synced_from as syncedFrom, synced_to as syncedTo, synced_at as syncedAt,
             trade_count_total as tradeCountTotal, collateral_volume as collateralVolume,
             profit, has_full_history as hasFullHistory
      FROM accounts WHERE wallet = ?
    `).get(wallet.toLowerCase()) as {
      wallet: string; creationTimestamp: number | null;
      syncedFrom: number | null; syncedTo: number | null; syncedAt: number | null;
      tradeCountTotal: number | null; collateralVolume: number | null;
      profit: number | null; hasFullHistory: number;
    } | undefined;

    if (!row) return null;
    return { ...row, hasFullHistory: row.hasFullHistory === 1 };
  }

  updateSyncedTo(wallet: string, timestamp: number): void {
    this.db.prepare(`
      UPDATE accounts SET synced_to = ?, synced_at = strftime('%s', 'now')
      WHERE wallet = ?
    `).run(timestamp, wallet.toLowerCase());
  }

  markComplete(wallet: string): void {
    this.db.prepare(`UPDATE accounts SET has_full_history = 1 WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }

  /**
   * Calculate aggregated volume for a wallet at a point in time.
   * Uses proper aggregation logic to avoid double-counting:
   * 1. Groups fills by txHash + outcome + role
   * 2. When wallet is both maker and taker, picks higher value role
   * 3. Filters complementary trades (YES + NO in same tx)
   */
  getAggregatedVolumeAt(wallet: string, atTimestamp: number): {
    volume: number;
    tradeCount: number;
    marketsNotFound: string[];
  } {
    const walletLower = wallet.toLowerCase();

    // Step 1: Get all fills for this wallet before timestamp
    const fills = this.getFillsForWallet(walletLower, {
      before: atTimestamp,
      role: 'both', // Need both to properly deduplicate
    });

    if (fills.length === 0) {
      return { volume: 0, tradeCount: 0, marketsNotFound: [] };
    }

    // Step 2: Get unique token IDs from fills
    const tokenIds = [...new Set(fills.map(f => f.market))];

    // Step 3: Load market metadata from DB
    const markets = this.getMarketsForTokenIds(tokenIds);

    // Step 4: Build tokenToOutcome map
    const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
    const marketsNotFound: string[] = [];

    for (const tokenId of tokenIds) {
      const market = markets.get(tokenId);
      if (market && market.outcomeIndex !== null) {
        // Use outcomeIndex (0 = YES, 1 = NO) - more reliable than string matching
        // for non-binary markets (e.g., "Up"/"Down")
        tokenToOutcome.set(tokenId.toLowerCase(),
          market.outcomeIndex === 0 ? 'YES' : 'NO');
      } else {
        marketsNotFound.push(tokenId);
        // Default to YES if market not found (graceful degradation)
        tokenToOutcome.set(tokenId.toLowerCase(), 'YES');
      }
    }

    // Step 5: Convert DBEnrichedOrderFill to SubgraphTrade format
    const subgraphFills: SubgraphTrade[] = fills.map(f => ({
      id: f.id,
      transactionHash: f.transactionHash,
      timestamp: f.timestamp,
      maker: f.maker,
      taker: f.taker,
      marketId: f.market,
      side: f.side,
      size: f.size.toString(), // Already in 6 decimals, aggregator does parseFloat/1e6
      price: (f.price / 1e6).toString(), // Convert from integer to decimal string
    }));

    // Step 6: Aggregate fills properly
    const aggregatedTrades = aggregateFills(subgraphFills, {
      wallet: walletLower,
      tokenToOutcome,
    });

    // Step 7: Sum totalValueUsd from aggregated trades
    const volume = aggregatedTrades.reduce((sum, t) => sum + t.totalValueUsd, 0);

    return {
      volume,
      tradeCount: aggregatedTrades.length,
      marketsNotFound,
    };
  }

  getAccountStateAt(wallet: string, atTimestamp: number): PointInTimeState {
    const account = this.getAccount(wallet);
    const hasIncompleteHistory = !account || !account.hasFullHistory ||
      (account.syncedFrom !== null && account.syncedFrom > atTimestamp);

    // Use aggregated volume calculation instead of naive SUM(size)
    const { volume, tradeCount, marketsNotFound } = this.getAggregatedVolumeAt(wallet, atTimestamp);

    // Log warning if some markets weren't found (affects accuracy)
    if (marketsNotFound.length > 0 && process.env.DEBUG) {
      console.warn(`getAccountStateAt: ${marketsNotFound.length} market(s) not in DB for wallet ${wallet.slice(0, 10)}`);
    }

    return {
      tradeCount,
      volume: Math.round(volume * 1e6), // Convert back to 6 decimals for compatibility
      pnl: 0, // TODO: Requires market resolution data to compute
      approximate: hasIncompleteHistory || marketsNotFound.length > 0,
    };
  }

  saveRedemptions(redemptions: DBRedemption[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO redemptions (id, wallet, condition_id, timestamp, payout)
      VALUES (?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const insertMany = this.db.transaction((redemptions: DBRedemption[]) => {
      for (const r of redemptions) {
        inserted += stmt.run(r.id, r.wallet.toLowerCase(), r.conditionId, r.timestamp, r.payout).changes;
      }
    });
    insertMany(redemptions);
    return inserted;
  }

  getRedemptionsForWallet(wallet: string): DBRedemption[] {
    return this.db.prepare(`
      SELECT id, wallet, condition_id as conditionId, timestamp, payout
      FROM redemptions WHERE wallet = ? ORDER BY timestamp DESC
    `).all(wallet.toLowerCase()) as DBRedemption[];
  }

  saveMarkets(markets: DBMarket[]): number {
    // Use UPSERT to update metadata but preserve sync columns (synced_from, synced_to, etc.)
    const stmt = this.db.prepare(`
      INSERT INTO markets (token_id, condition_id, question, outcome, outcome_index, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        condition_id = excluded.condition_id,
        question = excluded.question,
        outcome = excluded.outcome,
        outcome_index = excluded.outcome_index,
        resolved_at = excluded.resolved_at
    `);
    let inserted = 0;
    const insertMany = this.db.transaction((markets: DBMarket[]) => {
      for (const m of markets) {
        const result = stmt.run(m.tokenId, m.conditionId, m.question, m.outcome, m.outcomeIndex, m.resolvedAt);
        inserted += result.changes;
      }
    });
    insertMany(markets);
    return inserted;
  }

  getMarket(tokenId: string): DBMarket | null {
    const row = this.db.prepare(`
      SELECT token_id as tokenId, condition_id as conditionId, question, outcome, outcome_index as outcomeIndex, resolved_at as resolvedAt
      FROM markets WHERE token_id = ?
    `).get(tokenId) as DBMarket | undefined;
    return row ?? null;
  }

  getMarketsForTokenIds(tokenIds: string[]): Map<string, DBMarket> {
    const result = new Map<string, DBMarket>();
    if (tokenIds.length === 0) return result;

    const placeholders = tokenIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT token_id as tokenId, condition_id as conditionId, question, outcome, outcome_index as outcomeIndex, resolved_at as resolvedAt
      FROM markets WHERE token_id IN (${placeholders})
    `).all(...tokenIds) as DBMarket[];

    for (const row of rows) {
      result.set(row.tokenId, row);
    }
    return result;
  }

  getMarketSync(tokenId: string): DBMarketSync | null {
    const row = this.db.prepare(`
      SELECT token_id as tokenId,
             synced_from as syncedFrom,
             synced_to as syncedTo,
             synced_at as syncedAt,
             has_complete_history as hasCompleteHistory
      FROM markets WHERE token_id = ?
    `).get(tokenId) as {
      tokenId: string;
      syncedFrom: number | null;
      syncedTo: number | null;
      syncedAt: number | null;
      hasCompleteHistory: number | null;
    } | undefined;

    if (!row) return null;
    return {
      tokenId: row.tokenId,
      syncedFrom: row.syncedFrom,
      syncedTo: row.syncedTo,
      syncedAt: row.syncedAt,
      hasCompleteHistory: row.hasCompleteHistory === 1,
    };
  }

  updateMarketSync(
    tokenId: string,
    sync: { syncedFrom?: number; syncedTo?: number; hasCompleteHistory?: boolean }
  ): void {
    const updates: string[] = [];
    const params: (number | string)[] = [];

    if (sync.syncedFrom !== undefined) {
      updates.push('synced_from = ?');
      params.push(sync.syncedFrom);
    }
    if (sync.syncedTo !== undefined) {
      updates.push('synced_to = ?');
      params.push(sync.syncedTo);
    }
    if (sync.hasCompleteHistory !== undefined) {
      updates.push('has_complete_history = ?');
      params.push(sync.hasCompleteHistory ? 1 : 0);
    }

    if (updates.length === 0) return;

    updates.push("synced_at = strftime('%s', 'now')");
    params.push(tokenId);

    this.db.prepare(`
      UPDATE markets SET ${updates.join(', ')} WHERE token_id = ?
    `).run(...params);
  }

  queueBackfill(wallet: string, priority: number = 0): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO backfill_queue (wallet, priority, created_at, started_at, completed_at)
      VALUES (?, ?, strftime('%s', 'now'), NULL, NULL)
    `).run(wallet.toLowerCase(), priority);
  }

  getBackfillQueue(limit?: number): BackfillQueueItem[] {
    let sql = `
      SELECT wallet, priority, created_at as createdAt, started_at as startedAt, completed_at as completedAt
      FROM backfill_queue WHERE completed_at IS NULL ORDER BY priority DESC, created_at ASC
    `;
    if (limit) sql += ` LIMIT ${limit}`;
    return this.db.prepare(sql).all() as BackfillQueueItem[];
  }

  markBackfillStarted(wallet: string): void {
    this.db.prepare(`UPDATE backfill_queue SET started_at = strftime('%s', 'now') WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }

  markBackfillComplete(wallet: string): void {
    this.db.prepare(`UPDATE backfill_queue SET completed_at = strftime('%s', 'now') WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }

  hasQueuedBackfill(wallet: string): boolean {
    return this.db.prepare(`SELECT 1 FROM backfill_queue WHERE wallet = ? AND completed_at IS NULL`)
      .get(wallet.toLowerCase()) !== undefined;
  }

  savePrices(tokenId: string, prices: DBPricePoint[]): number {
    if (prices.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO price_history (token_id, timestamp, price)
      VALUES (?, ?, ?)
    `);

    let inserted = 0;

    const insertMany = this.db.transaction((prices: DBPricePoint[]) => {
      for (const p of prices) {
        // Store price as 6-decimal scaled integer
        const result = stmt.run(tokenId, p.timestamp, Math.round(p.price * 1e6));
        inserted += result.changes;
      }
    });

    insertMany(prices);
    return inserted;
  }

  getPricesForToken(tokenId: string, startTs: number, endTs: number): DBPricePoint[] {
    const rows = this.db.prepare(`
      SELECT timestamp, price FROM price_history
      WHERE token_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(tokenId, startTs, endTs) as { timestamp: number; price: number }[];

    return rows.map(r => ({
      timestamp: r.timestamp,
      price: r.price / 1e6,  // Convert back to 0-1 decimal
    }));
  }

  getPriceSyncStatus(tokenId: string): PriceSyncStatus {
    const row = this.db.prepare(`
      SELECT MIN(timestamp) as syncedFrom, MAX(timestamp) as syncedTo
      FROM price_history WHERE token_id = ?
    `).get(tokenId) as { syncedFrom: number | null; syncedTo: number | null } | undefined;

    return {
      syncedFrom: row?.syncedFrom ?? undefined,
      syncedTo: row?.syncedTo ?? undefined,
    };
  }
}
