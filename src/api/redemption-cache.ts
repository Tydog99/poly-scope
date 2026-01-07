import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { SubgraphRedemption } from './types.js';

const CACHE_DIR = '.cache/redemptions';

export class RedemptionCache {
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

  load(wallet: string): SubgraphRedemption[] | null {
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

  save(wallet: string, redemptions: SubgraphRedemption[]): void {
    const cachePath = this.getCachePath(wallet);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(redemptions, null, 2));
  }

  /**
   * Load all cached redemptions for a list of wallets
   * Returns a map of wallet -> redemptions, and the list of wallets not in cache
   */
  loadBatch(wallets: string[]): {
    cached: Map<string, SubgraphRedemption[]>;
    uncached: string[];
  } {
    const cached = new Map<string, SubgraphRedemption[]>();
    const uncached: string[] = [];

    for (const wallet of wallets) {
      const redemptions = this.load(wallet);
      if (redemptions !== null) {
        cached.set(wallet.toLowerCase(), redemptions);
      } else {
        uncached.push(wallet);
      }
    }

    return { cached, uncached };
  }

  /**
   * Save a batch of redemptions
   */
  saveBatch(redemptionsByWallet: Map<string, SubgraphRedemption[]>): void {
    for (const [wallet, redemptions] of redemptionsByWallet) {
      this.save(wallet, redemptions);
    }
  }
}
