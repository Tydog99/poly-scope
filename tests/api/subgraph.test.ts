import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SubgraphClient, createSubgraphClient } from '../../src/api/subgraph.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SubgraphClient', () => {
  let client: SubgraphClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new SubgraphClient('test-api-key');
  });

  describe('getAccount', () => {
    it('fetches account data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              account: {
                id: '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9',
                creationTimestamp: '1735275941',
                lastSeenTimestamp: '1735948831',
                collateralVolume: '404357630000',
                numTrades: '268',
                profit: '-28076440000',
                scaledProfit: '-28076.44',
              },
            },
          }),
      });

      const account = await client.getAccount(
        '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9'
      );

      expect(account).not.toBeNull();
      expect(account!.id).toBe('0x31a56e9e690c621ed21de08cb559e9524cdb8ed9');
      expect(account!.creationTimestamp).toBe(1735275941);
      expect(account!.numTrades).toBe(268);
      expect(account!.collateralVolume).toBe('404357630000');
      expect(account!.profit).toBe('-28076440000');
    });

    it('returns null for non-existent account', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { account: null } }),
      });

      const account = await client.getAccount('0xnonexistent');
      expect(account).toBeNull();
    });

    it('normalizes wallet address to lowercase', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { account: null } }),
      });

      await client.getAccount('0xABCDEF123456');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('0xabcdef123456'),
        })
      );
    });
  });

  describe('getAccountBatch', () => {
    it('fetches multiple accounts in one query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              a0: {
                id: '0xwallet1',
                creationTimestamp: '1735275941',
                lastSeenTimestamp: '1735948831',
                collateralVolume: '100000000',
                numTrades: '10',
                profit: '5000000',
                scaledProfit: '5.00',
              },
              a1: {
                id: '0xwallet2',
                creationTimestamp: '1735000000',
                lastSeenTimestamp: '1735900000',
                collateralVolume: '200000000',
                numTrades: '20',
                profit: '-1000000',
                scaledProfit: '-1.00',
              },
            },
          }),
      });

      const accounts = await client.getAccountBatch(['0xwallet1', '0xwallet2']);

      expect(accounts.size).toBe(2);
      expect(accounts.get('0xwallet1')?.numTrades).toBe(10);
      expect(accounts.get('0xwallet2')?.numTrades).toBe(20);
    });
  });

  describe('getTradesByWallet', () => {
    it('fetches trades for a wallet', async () => {
      // Mock maker trades
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              enrichedOrderFilleds: [
                {
                  id: 'trade1',
                  transactionHash: '0xtx1',
                  timestamp: '1735948800',
                  maker: { id: '0xwallet' },
                  taker: { id: '0xcounterparty' },
                  side: 'Buy',
                  size: '7215000000',
                  price: '600000',
                },
              ],
            },
          }),
      });

      // Mock taker trades
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              enrichedOrderFilleds: [
                {
                  id: 'trade2',
                  transactionHash: '0xtx2',
                  timestamp: '1735948900',
                  maker: { id: '0xother' },
                  taker: { id: '0xwallet' },
                  side: 'Sell',
                  size: '1000000000',
                  price: '700000',
                },
              ],
            },
          }),
      });

      const trades = await client.getTradesByWallet('0xwallet');

      expect(trades).toHaveLength(2);
      // Trades are sorted by timestamp desc, so the later one comes first
      expect(trades[0].size).toBe('1000000000');
      expect(trades[0].side).toBe('Sell');
      expect(trades[1].size).toBe('7215000000');
      expect(trades[1].side).toBe('Buy');
    });

    it('deduplicates trades that appear in both maker and taker results', async () => {
      const sameTrade = {
        id: 'trade1',
        transactionHash: '0xtx1',
        timestamp: '1735948800',
        maker: { id: '0xwallet' },
        taker: { id: '0xwallet' }, // Same wallet as both
        side: 'Buy',
        size: '1000000000',
        price: '500000',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { enrichedOrderFilleds: [sameTrade] },
          }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { enrichedOrderFilleds: [sameTrade] },
          }),
      });

      const trades = await client.getTradesByWallet('0xwallet');

      // Should only have one trade, not two
      expect(trades).toHaveLength(1);
    });
  });

  describe('getTradesByMarket', () => {
    it('fetches trades for a specific token/market ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              enrichedOrderFilleds: [
                {
                  id: 'trade1',
                  transactionHash: '0xtx1',
                  timestamp: '1735948800',
                  maker: { id: '0xmaker' },
                  taker: { id: '0xtaker' },
                  market: { id: '0xtoken123' },
                  side: 'Buy',
                  size: '1000000000',
                  price: '500000',
                },
              ],
            },
          }),
      });

      const trades = await client.getTradesByMarket('0xtoken123');

      expect(trades).toHaveLength(1);
      expect(trades[0].transactionHash).toBe('0xtx1');
      expect(trades[0].marketId).toBe('0xtoken123');
      expect(trades[0].side).toBe('Buy');
    });

    it('passes time filters to query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { enrichedOrderFilleds: [] } }),
      });

      const after = new Date('2024-01-01');
      const before = new Date('2024-01-31');
      await client.getTradesByMarket('0xtoken', { after, before });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.variables).toHaveProperty('after', Math.floor(after.getTime() / 1000).toString());
      expect(callBody.variables).toHaveProperty('before', Math.floor(before.getTime() / 1000).toString());
      expect(callBody.query).toContain('$after');
      expect(callBody.query).toContain('$before');
    });
  });

  describe('getTradesBySize', () => {
    it('fetches trades within a USD range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              enrichedOrderFilleds: [
                {
                  id: 'trade1',
                  transactionHash: '0xtx1',
                  timestamp: '1735948800',
                  maker: { id: '0xmaker' },
                  taker: { id: '0xtaker' },
                  side: 'Buy',
                  size: '7215000000',
                  price: '600000',
                },
              ],
            },
          }),
      });

      const trades = await client.getTradesBySize(7000, 7500);

      expect(trades).toHaveLength(1);
      expect(trades[0].size).toBe('7215000000');
    });
  });

  describe('getPositions', () => {
    it('fetches market positions for a wallet', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              marketPositions: [
                {
                  id: 'pos1',
                  market: { id: '12345' },
                  valueBought: '32538340000',
                  valueSold: '0',
                  netValue: '32538340000',
                  quantityBought: '50000000000',
                  quantitySold: '0',
                  netQuantity: '50000000000',
                },
              ],
            },
          }),
      });

      const positions = await client.getPositions('0xwallet');

      expect(positions).toHaveLength(1);
      expect(positions[0].marketId).toBe('12345');
      expect(positions[0].valueBought).toBe('32538340000');
    });
  });

  describe('error handling', () => {
    it('retries on indexer errors', async () => {
      // First call fails with indexer error
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: 'bad indexers: timeout' }],
          }),
      });

      // Second call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { account: { id: '0xwallet', creationTimestamp: '1735275941', lastSeenTimestamp: '1735948831', collateralVolume: '100', numTrades: '1', profit: '0', scaledProfit: '0' } },
          }),
      });

      const account = await client.getAccount('0xwallet');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(account).not.toBeNull();
    });

    it('throws on non-retryable errors', async () => {
      // Reset mock and set up all retries to return the same error
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: 'Invalid query syntax' }],
          }),
      });

      await expect(client.getAccount('0xwallet')).rejects.toThrow(
        'Invalid query syntax'
      );
    });
  });

  describe('getTradesByMarket pagination', () => {
    it('fetches multiple pages using cursor (timestamp_lt)', async () => {
      // Page 1: 1000 trades, last trade at timestamp 1700000001
      const page1 = Array.from({ length: 1000 }, (_, i) => ({
        id: `t1-${i}`,
        transactionHash: `tx1-${i}`,
        timestamp: (1700001000 - i).toString(),
        maker: { id: 'm' },
        taker: { id: 't' },
        market: { id: 'm1' },
        side: 'Buy',
        size: '100',
        price: '0.5'
      }));

      // Page 2: 500 trades
      const page2 = Array.from({ length: 500 }, (_, i) => ({
        id: `t2-${i}`,
        transactionHash: `tx2-${i}`,
        timestamp: (1700000000 - i - 1).toString(),
        maker: { id: 'm' },
        taker: { id: 't' },
        market: { id: 'm1' },
        side: 'Buy',
        size: '100',
        price: '0.5'
      }));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { enrichedOrderFilleds: page1 } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { enrichedOrderFilleds: page2 } }),
        });

      const trades = await client.getTradesByMarket('m1', { limit: 2000 });

      expect(trades).toHaveLength(1500);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check second call parameters
      const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondCallBody.variables).toHaveProperty('lastTimestamp', '1700000001');
      expect(secondCallBody.query).toContain('timestamp_lt: $lastTimestamp');
    });
  });
});

describe('createSubgraphClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null when API key is not set', () => {
    delete process.env.THE_GRAPH_API_KEY;
    const client = createSubgraphClient();
    expect(client).toBeNull();
  });

  it('creates client when API key is set', () => {
    process.env.THE_GRAPH_API_KEY = 'test-key';
    const client = createSubgraphClient();
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(SubgraphClient);
  });
});
