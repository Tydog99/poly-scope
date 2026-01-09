import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TradeDB, DBTrade, DBRedemption } from './index.js';

export interface MigrationResult {
  trades: number;
  accounts: number;
  redemptions: number;
  errors: string[];
}

export interface ValidationResult {
  valid: boolean;
  dbCounts: { trades: number; accounts: number; redemptions: number };
  jsonCounts: { trades: number; accounts: number; redemptions: number };
  warnings: string[];
}

interface JsonTrade {
  transactionHash: string;
  wallet: string;
  marketId: string;
  timestamp: string;
  side: string;
  action: string;
  role: string;
  totalSize: number;
  avgPrice: number;
  totalValueUsd: number;
  fills: Array<{ id: string; size: number; price: number; valueUsd: number; timestamp: string }>;
}

interface JsonAccount {
  wallet: string;
  totalTrades: number;
  totalVolumeUsd: number;
  firstTradeDate: string | null;
  lastTradeDate: string | null;
  creationDate?: string;
  profitUsd?: number;
}

interface JsonRedemption {
  id: string;
  wallet: string;
  conditionId: string;
  timestamp: string;
  payout: number;
}

export function importJsonCaches(db: TradeDB, cacheDir: string = '.cache'): MigrationResult {
  const result: MigrationResult = { trades: 0, accounts: 0, redemptions: 0, errors: [] };

  // Import trades
  const tradesDir = join(cacheDir, 'trades');
  if (existsSync(tradesDir)) {
    for (const file of readdirSync(tradesDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(tradesDir, file), 'utf-8'));
        const trades: DBTrade[] = (data.trades || []).flatMap((t: JsonTrade) =>
          t.fills.map(f => ({
            id: f.id,
            txHash: t.transactionHash,
            wallet: t.wallet,
            marketId: t.marketId,
            timestamp: Math.floor(new Date(f.timestamp).getTime() / 1000),
            side: t.side,
            action: t.action,
            role: t.role,
            size: Math.round(f.size * 1e6),
            price: Math.round(f.price * 1e6),
            valueUsd: Math.round(f.valueUsd * 1e6),
          }))
        );
        result.trades += db.saveTrades(trades);
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  // Import accounts
  const accountsDir = join(cacheDir, 'accounts');
  if (existsSync(accountsDir)) {
    for (const file of readdirSync(accountsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data: JsonAccount = JSON.parse(readFileSync(join(accountsDir, file), 'utf-8'));
        const existing = db.getAccount(data.wallet);
        if (!existing) {
          db.saveAccount({
            wallet: data.wallet,
            creationTimestamp: data.creationDate ? Math.floor(new Date(data.creationDate).getTime() / 1000) : null,
            syncedFrom: data.firstTradeDate ? Math.floor(new Date(data.firstTradeDate).getTime() / 1000) : null,
            syncedTo: data.lastTradeDate ? Math.floor(new Date(data.lastTradeDate).getTime() / 1000) : null,
            syncedAt: Math.floor(Date.now() / 1000),
            tradeCountTotal: data.totalTrades,
            collateralVolume: Math.round(data.totalVolumeUsd * 1e6),
            profit: data.profitUsd ? Math.round(data.profitUsd * 1e6) : null,
            hasFullHistory: false,
          });
          result.accounts++;
        }
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  // Import redemptions
  const redemptionsDir = join(cacheDir, 'redemptions');
  if (existsSync(redemptionsDir)) {
    for (const file of readdirSync(redemptionsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(redemptionsDir, file), 'utf-8'));
        const redemptions: DBRedemption[] = (data.redemptions || []).map((r: JsonRedemption) => ({
          id: r.id,
          wallet: r.wallet,
          conditionId: r.conditionId,
          timestamp: Math.floor(new Date(r.timestamp).getTime() / 1000),
          payout: Math.round(r.payout * 1e6),
        }));
        result.redemptions += db.saveRedemptions(redemptions);
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  return result;
}

function countJsonRecords(dir: string, arrayKey?: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (arrayKey) {
        count += (data[arrayKey] || []).length;
      } else {
        count++;
      }
    } catch { /* ignore */ }
  }
  return count;
}

export function validateMigration(db: TradeDB, cacheDir: string = '.cache'): ValidationResult {
  const dbCounts = {
    trades: db.getStatus().trades,
    accounts: db.getStatus().accounts,
    redemptions: db.getStatus().redemptions,
  };

  // Count trades by fills, not by file
  let jsonTradeCount = 0;
  const tradesDir = join(cacheDir, 'trades');
  if (existsSync(tradesDir)) {
    for (const file of readdirSync(tradesDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(tradesDir, file), 'utf-8'));
        for (const trade of data.trades || []) {
          jsonTradeCount += (trade.fills || []).length;
        }
      } catch { /* ignore */ }
    }
  }

  const jsonCounts = {
    trades: jsonTradeCount,
    accounts: countJsonRecords(join(cacheDir, 'accounts')),
    redemptions: countJsonRecords(join(cacheDir, 'redemptions'), 'redemptions'),
  };

  const warnings: string[] = [];
  if (dbCounts.trades > jsonCounts.trades) {
    warnings.push(`DB has more trades than JSON (deduplication or prior imports)`);
  }

  return {
    valid: dbCounts.trades === jsonCounts.trades &&
           dbCounts.accounts === jsonCounts.accounts &&
           dbCounts.redemptions === jsonCounts.redemptions,
    dbCounts,
    jsonCounts,
    warnings,
  };
}
