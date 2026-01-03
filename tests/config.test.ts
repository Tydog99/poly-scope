import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('config', () => {
  it('returns default config when no file exists', () => {
    const config = loadConfig('/nonexistent/path.json');
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('has correct default weights', () => {
    expect(DEFAULT_CONFIG.weights.tradeSize).toBe(40);
    expect(DEFAULT_CONFIG.weights.accountHistory).toBe(35);
    expect(DEFAULT_CONFIG.weights.conviction).toBe(25);
  });

  it('has correct default thresholds', () => {
    expect(DEFAULT_CONFIG.tradeSize.minAbsoluteUsd).toBe(5000);
    expect(DEFAULT_CONFIG.accountHistory.maxLifetimeTrades).toBe(10);
    expect(DEFAULT_CONFIG.conviction.minPositionPercent).toBe(80);
    expect(DEFAULT_CONFIG.alertThreshold).toBe(70);
  });
});
