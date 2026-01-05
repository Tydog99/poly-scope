import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountCache } from '../../src/api/account-cache.js';
import * as fs from 'fs';
import { join } from 'path';

vi.mock('fs', () => ({
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    rmdirSync: vi.fn(),
}));

describe('AccountCache', () => {
    const cacheDir = '.test-cache/accounts';
    let cache: AccountCache;

    beforeEach(() => {
        vi.resetAllMocks();
        cache = new AccountCache(cacheDir);
    });

    const mockHistory = {
        wallet: '0x123',
        totalTrades: 10,
        firstTradeDate: new Date('2024-01-01T00:00:00.000Z'),
        lastTradeDate: new Date('2024-01-02T00:00:00.000Z'),
        totalVolumeUsd: 1000,
        creationDate: new Date('2023-12-31T00:00:00.000Z'),
        profitUsd: 50,
        dataSource: 'subgraph' as const,
    };

    it('saves account history to file', () => {
        cache.save(mockHistory);

        expect(fs.mkdirSync).toHaveBeenCalledWith(cacheDir, { recursive: true });

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            join(cacheDir, '0x123.json'),
            JSON.stringify(mockHistory, null, 2)
        );
    });

    it('loads account history from file', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockHistory));

        const loaded = cache.load('0x123');

        expect(loaded).toEqual(mockHistory);
        expect(loaded?.firstTradeDate).toBeInstanceOf(Date);
        expect(loaded?.creationDate).toBeInstanceOf(Date);
    });

    it('returns null if file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const loaded = cache.load('0x123');
        expect(loaded).toBeNull();
    });

    it('handle read errors gracefully', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('File corrupted'); });

        const loaded = cache.load('0x123');
        expect(loaded).toBeNull();
    });
});
