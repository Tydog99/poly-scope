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
}
