import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolymarketClient } from '../../src/api/client.js';

// Mock the clob-client
vi.mock('@polymarket/clob-client', () => {
  return {
    ClobClient: class MockClobClient {
      getMarket = vi.fn().mockResolvedValue({
        condition_id: 'test-condition',
        question: 'Test question?',
        tokens: [
          { token_id: 'yes-token', outcome: 'Yes' },
          { token_id: 'no-token', outcome: 'No' },
        ],
        end_date_iso: '2024-02-01T00:00:00Z',
      });
    },
    Chain: {
      POLYGON: 137,
      AMOY: 80002,
    },
  };
});

describe('PolymarketClient', () => {
  let client: PolymarketClient;

  beforeEach(() => {
    client = new PolymarketClient();
  });

  it('fetches market by condition ID', async () => {
    const market = await client.getMarket('test-condition');

    expect(market.conditionId).toBe('test-condition');
    expect(market.question).toBe('Test question?');
    expect(market.outcomes).toContain('Yes');
  });

  it('exposes correct API host', () => {
    expect(client.host).toContain('clob.polymarket.com');
  });
});
