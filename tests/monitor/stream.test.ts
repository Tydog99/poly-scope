import { describe, it, expect } from 'vitest';
import { calculateBackoff } from '../../src/monitor/stream.js';

describe('MonitorStream', () => {
  describe('calculateBackoff', () => {
    it('returns initial delay on first attempt', () => {
      const delay = calculateBackoff(0, { initialMs: 1000, multiplier: 2, maxMs: 30000 });
      expect(delay).toBe(1000);
    });

    it('doubles delay on each attempt', () => {
      const config = { initialMs: 1000, multiplier: 2, maxMs: 30000 };
      expect(calculateBackoff(1, config)).toBe(2000);
      expect(calculateBackoff(2, config)).toBe(4000);
      expect(calculateBackoff(3, config)).toBe(8000);
    });

    it('caps delay at maxMs', () => {
      const config = { initialMs: 1000, multiplier: 2, maxMs: 30000 };
      expect(calculateBackoff(10, config)).toBe(30000);
    });
  });
});
