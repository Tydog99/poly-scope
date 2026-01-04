import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { Trade } from '../signals/types.js';

const CACHE_DIR = '.cache/trades';

interface CacheData {
  marketId: string;
  newestTimestamp: number; // Most recent trade timestamp (seconds)
  oldestTimestamp: number; // Oldest trade timestamp (seconds)
  trades: Trade[];
}

export class TradeCache {
  private cacheDir: string;

  constructor(cacheDir: string = CACHE_DIR) {
    this.cacheDir = cacheDir;
  }

  private getCachePath(marketId: string): string {
    const shortId = marketId.startsWith('0x') ? marketId.slice(0, 18) : marketId.slice(0, 16);
    return join(this.cacheDir, `${shortId}.json`);
  }

  load(marketId: string): CacheData | null {
    const cachePath = this.getCachePath(marketId);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const data = readFileSync(cachePath, 'utf-8');
      const raw = JSON.parse(data) as CacheData & { trades: Array<Trade & { timestamp: string }> };
      return {
        ...raw,
        trades: raw.trades.map(t => ({
          ...t,
          timestamp: new Date(t.timestamp),
        })),
      };
    } catch {
      return null;
    }
  }

  save(data: CacheData): void {
    const cachePath = this.getCachePath(data.marketId);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data, null, 2));
  }

  merge(marketId: string, newTrades: Trade[]): CacheData {
    const existing = this.load(marketId);
    const existingTrades = existing?.trades ?? [];

    // Deduplicate by trade ID
    const existingIds = new Set(existingTrades.map(t => t.id));
    const uniqueNewTrades = newTrades.filter(t => !existingIds.has(t.id));

    const allTrades = [...uniqueNewTrades, ...existingTrades];

    // Sort by timestamp descending (newest first)
    allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const data: CacheData = {
      marketId,
      newestTimestamp: allTrades.length > 0
        ? Math.floor(allTrades[0].timestamp.getTime() / 1000)
        : 0,
      oldestTimestamp: allTrades.length > 0
        ? Math.floor(allTrades[allTrades.length - 1].timestamp.getTime() / 1000)
        : 0,
      trades: allTrades,
    };

    this.save(data);
    return data;
  }
}
