import { describe, it, expect } from 'vitest';

/**
 * Tests for CLI date parsing behavior.
 *
 * The --before flag should use end of day (23:59:59.999) so that
 * "--before 2026-01-03" includes all trades on January 3rd.
 */
describe('CLI date parsing', () => {
  // This mirrors the logic in src/index.ts for parsing --before
  const parseBeforeDate = (dateStr: string): Date => {
    // End of day: add 24 hours minus 1 millisecond
    return new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000 - 1);
  };

  // Standard date parsing for --after
  const parseAfterDate = (dateStr: string): Date => {
    return new Date(dateStr);
  };

  describe('--after date parsing', () => {
    it('parses to start of day (midnight)', () => {
      const after = parseAfterDate('2026-01-03');
      expect(after.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    });

    it('includes trades on that day', () => {
      const after = parseAfterDate('2026-01-03');
      const tradeOnJan3 = new Date('2026-01-03T12:00:00Z');
      expect(tradeOnJan3 >= after).toBe(true);
    });

    it('excludes trades before that day', () => {
      const after = parseAfterDate('2026-01-03');
      const tradeOnJan2 = new Date('2026-01-02T23:59:59Z');
      expect(tradeOnJan2 >= after).toBe(false);
    });
  });

  describe('--before date parsing', () => {
    it('parses to end of day (23:59:59.999)', () => {
      const before = parseBeforeDate('2026-01-03');
      expect(before.toISOString()).toBe('2026-01-03T23:59:59.999Z');
    });

    it('includes trades on that day (morning)', () => {
      const before = parseBeforeDate('2026-01-03');
      const morningTrade = new Date('2026-01-03T08:00:00Z');
      expect(morningTrade <= before).toBe(true);
    });

    it('includes trades on that day (evening)', () => {
      const before = parseBeforeDate('2026-01-03');
      const eveningTrade = new Date('2026-01-03T20:00:00Z');
      expect(eveningTrade <= before).toBe(true);
    });

    it('excludes trades on the next day', () => {
      const before = parseBeforeDate('2026-01-03');
      const nextDayTrade = new Date('2026-01-04T00:00:00Z');
      expect(nextDayTrade <= before).toBe(false);
    });
  });

  describe('date range behavior', () => {
    it('--after 2026-01-01 --before 2026-01-03 includes Jan 1, 2, and 3', () => {
      const after = parseAfterDate('2026-01-01');
      const before = parseBeforeDate('2026-01-03');

      const jan1 = new Date('2026-01-01T12:00:00Z');
      const jan2 = new Date('2026-01-02T12:00:00Z');
      const jan3Morning = new Date('2026-01-03T08:00:00Z');
      const jan3Evening = new Date('2026-01-03T20:00:00Z');
      const jan4 = new Date('2026-01-04T00:00:01Z');

      const inRange = (d: Date) => d >= after && d <= before;

      expect(inRange(jan1)).toBe(true);
      expect(inRange(jan2)).toBe(true);
      expect(inRange(jan3Morning)).toBe(true);
      expect(inRange(jan3Evening)).toBe(true);
      expect(inRange(jan4)).toBe(false);
    });

    it('would have failed with old behavior (before = start of day)', () => {
      const after = parseAfterDate('2026-01-01');
      // OLD BUGGY BEHAVIOR: before was midnight start of day
      const beforeOld = new Date('2026-01-03T00:00:00.000Z');

      const jan3Morning = new Date('2026-01-03T08:00:00Z');
      const jan3Evening = new Date('2026-01-03T20:00:00Z');

      // These would incorrectly be excluded with old behavior
      expect(jan3Morning <= beforeOld).toBe(false); // Bug!
      expect(jan3Evening <= beforeOld).toBe(false); // Bug!
    });
  });
});
