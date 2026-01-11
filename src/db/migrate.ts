import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TradeDB, DBEnrichedOrderFill, DBRedemption } from './index.js';

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

// New aggregated format (with fills array)
interface JsonTradeAggregated {
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

// Old flat format (each trade is a single fill)
interface JsonTradeFlat {
  id: string;
  wallet: string;
  marketId: string;
  timestamp: string;
  side: string;
  role: string;
  size: number;
  price: number;
  valueUsd: number;
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
        const rawTrades = data.trades || [];

        // Detect format: new aggregated (has fills array) vs old flat (no fills)
        const isAggregatedFormat = rawTrades.length > 0 && Array.isArray(rawTrades[0].fills);

        let fills: DBEnrichedOrderFill[];
        if (isAggregatedFormat) {
          // New format: flatten fills from aggregated trades
          fills = rawTrades.flatMap((t: JsonTradeAggregated) =>
            t.fills.map(f => ({
              id: f.id,
              transactionHash: t.transactionHash,
              timestamp: Math.floor(new Date(f.timestamp).getTime() / 1000),
              orderHash: '', // Not available in JSON cache
              side: t.side === 'BUY' ? 'Buy' as const : 'Sell' as const,
              size: Math.round(f.size * 1e6),
              price: Math.round(f.price * 1e6),
              // Map wallet to maker/taker based on role
              maker: t.role === 'maker' ? t.wallet : '',
              taker: t.role === 'taker' ? t.wallet : '',
              market: t.marketId,
            }))
          );
        } else {
          // Old flat format: each trade is already a fill
          fills = rawTrades.map((t: JsonTradeFlat) => ({
            id: t.id,
            transactionHash: t.id.split('-')[0] || t.id, // Extract txHash from id if available
            timestamp: Math.floor(new Date(t.timestamp).getTime() / 1000),
            orderHash: '', // Not available in JSON cache
            side: t.side === 'BUY' ? 'Buy' as const : 'Sell' as const,
            size: Math.round(t.size * 1e6),
            price: Math.round(t.price * 1e6),
            // Map wallet to maker/taker based on role
            maker: t.role === 'maker' ? t.wallet : '',
            taker: t.role === 'taker' ? t.wallet : '',
            market: t.marketId,
          }));
        }

        result.trades += db.saveFills(fills);
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
  const status = db.getStatus();
  const dbCounts = {
    trades: status.fills,  // Use fills count (trades renamed to fills)
    accounts: status.accounts,
    redemptions: status.redemptions,
  };

  // Count unique trade IDs across all files (trades can appear in multiple market files)
  const uniqueTradeIds = new Set<string>();
  const tradesDir = join(cacheDir, 'trades');
  if (existsSync(tradesDir)) {
    for (const file of readdirSync(tradesDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(tradesDir, file), 'utf-8'));
        const rawTrades = data.trades || [];
        const isAggregatedFormat = rawTrades.length > 0 && Array.isArray(rawTrades[0].fills);

        if (isAggregatedFormat) {
          // New format: collect fill IDs
          for (const trade of rawTrades) {
            for (const fill of trade.fills || []) {
              uniqueTradeIds.add(fill.id);
            }
          }
        } else {
          // Old flat format: each trade has its own ID
          for (const trade of rawTrades) {
            uniqueTradeIds.add(trade.id);
          }
        }
      } catch { /* ignore */ }
    }
  }

  const jsonCounts = {
    trades: uniqueTradeIds.size,
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
