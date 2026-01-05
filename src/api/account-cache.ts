import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { AccountHistory } from '../signals/types.js';

const CACHE_DIR = '.cache/accounts';

export class AccountCache {
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

    load(wallet: string): AccountHistory | null {
        const cachePath = this.getCachePath(wallet);

        if (!existsSync(cachePath)) {
            return null;
        }

        try {
            const data = readFileSync(cachePath, 'utf-8');
            const raw = JSON.parse(data);

            // Rehydrate Dates
            return {
                ...raw,
                firstTradeDate: raw.firstTradeDate ? new Date(raw.firstTradeDate) : null,
                lastTradeDate: raw.lastTradeDate ? new Date(raw.lastTradeDate) : null,
                creationDate: raw.creationDate ? new Date(raw.creationDate) : undefined,
            };
        } catch {
            return null;
        }
    }

    save(data: AccountHistory): void {
        const cachePath = this.getCachePath(data.wallet);
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(data, null, 2));
    }
}
