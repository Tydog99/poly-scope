import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlugResolver } from '../../src/api/slug.js';

describe('SlugResolver', () => {
  let resolver: SlugResolver;

  beforeEach(() => {
    resolver = new SlugResolver();
    vi.resetAllMocks();
  });

  it('returns condition ID as-is when input starts with 0x', async () => {
    const conditionId = '0xabc123def456';
    const result = await resolver.resolve(conditionId);

    expect(result).toHaveLength(1);
    expect(result[0].conditionId).toBe(conditionId);
  });

  it('fetches from Gamma API when input is a slug', async () => {
    const mockEvent = {
      id: '123',
      slug: 'test-event',
      title: 'Test Event',
      markets: [
        {
          id: '1',
          conditionId: '0xmarket1',
          question: 'Will X happen?',
          outcomes: ['Yes', 'No'],
          outcomePrices: '[0.5, 0.5]',
          volume: '1000',
          active: true,
          closed: false,
        },
        {
          id: '2',
          conditionId: '0xmarket2',
          question: 'Will Y happen?',
          outcomes: ['Yes', 'No'],
          outcomePrices: '[0.3, 0.7]',
          volume: '2000',
          active: true,
          closed: false,
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockEvent),
    });

    const result = await resolver.resolve('test-event');

    expect(fetch).toHaveBeenCalledWith(
      'https://gamma-api.polymarket.com/events/slug/test-event'
    );
    expect(result).toHaveLength(2);
    expect(result[0].conditionId).toBe('0xmarket1');
    expect(result[0].question).toBe('Will X happen?');
    expect(result[1].conditionId).toBe('0xmarket2');
  });

  it('throws error when slug not found', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
    });

    await expect(resolver.resolve('invalid-slug')).rejects.toThrow(
      'Failed to resolve slug "invalid-slug": Not Found'
    );
  });
});
