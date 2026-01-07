import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const CACHE_DIR = '.cache/trade-counts';

export interface TradeCountData {
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export class TradeCountCache {
  private cacheDir: string;

  constructor(cacheDir: string = CACHE_DIR) {
    this.cacheDir = cacheDir;
  }

  private getCachePath(wallet: string): string {
    return join(this.cacheDir, `${wallet.toLowerCase()}.json`);
  }

  has(wallet: string): boolean {
    return existsSync(this.getCachePath(wallet));
  }

  load(wallet: string): TradeCountData | null {
    const cachePath = this.getCachePath(wallet);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const data = readFileSync(cachePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  save(wallet: string, data: TradeCountData): void {
    const cachePath = this.getCachePath(wallet);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data));
  }

  /**
   * Load cached trade counts for a list of wallets
   * Returns cached data and list of wallets not in cache
   */
  loadBatch(wallets: string[]): {
    cached: Map<string, TradeCountData>;
    uncached: string[];
  } {
    const cached = new Map<string, TradeCountData>();
    const uncached: string[] = [];

    for (const wallet of wallets) {
      const data = this.load(wallet);
      if (data !== null) {
        cached.set(wallet.toLowerCase(), data);
      } else {
        uncached.push(wallet);
      }
    }

    return { cached, uncached };
  }

  /**
   * Save a batch of trade counts
   */
  saveBatch(countsByWallet: Map<string, TradeCountData>): void {
    for (const [wallet, data] of countsByWallet) {
      this.save(wallet, data);
    }
  }
}
