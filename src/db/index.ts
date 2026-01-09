import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { initializeSchema } from './schema.js';

export interface DBStatus {
  path: string;
  trades: number;
  accounts: number;
  redemptions: number;
  markets: number;
  backfillQueue: number;
}

export interface DBTrade {
  id: string;
  txHash: string;
  wallet: string;
  marketId: string;
  timestamp: number;
  side: string;
  action: string;
  role: string;
  size: number;
  price: number;
  valueUsd: number;
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

export interface GetTradesForMarketOptions {
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
      trades: count('trades'),
      accounts: count('accounts'),
      redemptions: count('redemptions'),
      markets: count('markets'),
      backfillQueue: count('backfill_queue'),
    };
  }

  saveTrades(trades: DBTrade[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO trades
      (id, tx_hash, wallet, market_id, timestamp, side, action, role, size, price, value_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;

    const insertMany = this.db.transaction((trades: DBTrade[]) => {
      for (const t of trades) {
        const result = stmt.run(
          t.id, t.txHash, t.wallet.toLowerCase(), t.marketId,
          t.timestamp, t.side, t.action, t.role, t.size, t.price, t.valueUsd
        );
        inserted += result.changes;
      }
    });

    insertMany(trades);
    return inserted;
  }

  getTradesForWallet(wallet: string, options: { before?: number } = {}): DBTrade[] {
    let sql = `
      SELECT id, tx_hash as txHash, wallet, market_id as marketId,
             timestamp, side, action, role, size, price, value_usd as valueUsd
      FROM trades WHERE wallet = ?
    `;
    const params: (string | number)[] = [wallet.toLowerCase()];

    if (options.before) {
      sql += ' AND timestamp < ?';
      params.push(options.before);
    }
    sql += ' ORDER BY timestamp DESC';

    return this.db.prepare(sql).all(...params) as DBTrade[];
  }

  getTradesForMarket(marketId: string, options: GetTradesForMarketOptions = {}): DBTrade[] {
    let sql = `
      SELECT id, tx_hash as txHash, wallet, market_id as marketId,
             timestamp, side, action, role, size, price, value_usd as valueUsd
      FROM trades WHERE market_id = ?
    `;
    const params: (string | number)[] = [marketId];

    if (options.after !== undefined) {
      sql += ' AND timestamp >= ?';
      params.push(options.after);
    }
    if (options.before !== undefined) {
      sql += ' AND timestamp <= ?';
      params.push(options.before);
    }
    if (options.role && options.role !== 'both') {
      sql += ' AND role = ?';
      params.push(options.role);
    }

    sql += ' ORDER BY timestamp DESC';

    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.db.prepare(sql).all(...params) as DBTrade[];
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

  getAccountStateAt(wallet: string, atTimestamp: number): PointInTimeState {
    const account = this.getAccount(wallet);
    const approximate = !account || !account.hasFullHistory ||
      (account.syncedFrom !== null && account.syncedFrom > atTimestamp);

    const result = this.db.prepare(`
      SELECT COUNT(*) as tradeCount, COALESCE(SUM(value_usd), 0) as volume,
        COALESCE(SUM(CASE WHEN action = 'SELL' THEN value_usd ELSE 0 END) -
                 SUM(CASE WHEN action = 'BUY' THEN value_usd ELSE 0 END), 0) as pnl
      FROM trades WHERE wallet = ? AND timestamp < ?
    `).get(wallet.toLowerCase(), atTimestamp) as { tradeCount: number; volume: number; pnl: number };

    return { ...result, approximate };
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
}
