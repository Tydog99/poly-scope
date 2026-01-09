import { describe, it, expect } from 'vitest';
import { parseMarketSelection } from '../../src/cli/prompt.js';

describe('parseMarketSelection', () => {
  describe('all selection', () => {
    it('returns all for "a"', () => {
      const result = parseMarketSelection('a', 4);
      expect(result.type).toBe('all');
    });

    it('returns all for "A" (case insensitive)', () => {
      const result = parseMarketSelection('A', 4);
      expect(result.type).toBe('all');
    });

    it('returns all for "all"', () => {
      const result = parseMarketSelection('all', 4);
      expect(result.type).toBe('all');
    });

    it('returns all for "ALL" (case insensitive)', () => {
      const result = parseMarketSelection('ALL', 4);
      expect(result.type).toBe('all');
    });

    it('returns all for "  a  " (with whitespace)', () => {
      const result = parseMarketSelection('  a  ', 4);
      expect(result.type).toBe('all');
    });
  });

  describe('numeric selection', () => {
    it('returns 0-indexed selection for "1"', () => {
      const result = parseMarketSelection('1', 4);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(0);
    });

    it('returns 0-indexed selection for "4" (last option)', () => {
      const result = parseMarketSelection('4', 4);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(3);
    });

    it('returns 0-indexed selection for "2"', () => {
      const result = parseMarketSelection('2', 4);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(1);
    });

    it('handles whitespace around number', () => {
      const result = parseMarketSelection('  3  ', 4);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(2);
    });
  });

  describe('invalid selection', () => {
    it('returns invalid for "0"', () => {
      const result = parseMarketSelection('0', 4);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('1-4');
    });

    it('returns invalid for number > market count', () => {
      const result = parseMarketSelection('5', 4);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('1-4');
    });

    it('returns invalid for negative number', () => {
      const result = parseMarketSelection('-1', 4);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('1-4');
    });

    it('returns invalid for random text', () => {
      const result = parseMarketSelection('foo', 4);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('Invalid selection');
    });

    it('returns invalid for empty string', () => {
      const result = parseMarketSelection('', 4);
      expect(result.type).toBe('invalid');
    });

    it('returns invalid for whitespace only', () => {
      const result = parseMarketSelection('   ', 4);
      expect(result.type).toBe('invalid');
    });

    it('returns invalid for decimal number', () => {
      const result = parseMarketSelection('1.5', 4);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(0); // parseInt('1.5') = 1
    });

    it('error message includes market count range', () => {
      const result = parseMarketSelection('invalid', 7);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('1-7');
      expect(result.error).toContain("'a' for all");
    });
  });

  describe('edge cases', () => {
    it('works with single market', () => {
      const result = parseMarketSelection('1', 1);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(0);
    });

    it('returns invalid for "2" when only 1 market', () => {
      const result = parseMarketSelection('2', 1);
      expect(result.type).toBe('invalid');
      expect(result.error).toContain('1-1');
    });

    it('works with many markets', () => {
      const result = parseMarketSelection('50', 100);
      expect(result.type).toBe('selection');
      expect(result.index).toBe(49);
    });

    it('handles "all" even with single market', () => {
      const result = parseMarketSelection('a', 1);
      expect(result.type).toBe('all');
    });
  });
});
