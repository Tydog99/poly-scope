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

  getTradesForMarket(marketId: string): DBTrade[] {
    return this.db.prepare(`
      SELECT id, tx_hash as txHash, wallet, market_id as marketId,
             timestamp, side, action, role, size, price, value_usd as valueUsd
      FROM trades WHERE market_id = ? ORDER BY timestamp DESC
    `).all(marketId) as DBTrade[];
  }
}
