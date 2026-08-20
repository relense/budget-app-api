import { describe, expect, it } from '@jest/globals';
import { isValidCalendarDate } from '../../src/lib/dateFormat.js';

describe('isValidCalendarDate', () => {
  it('accepts a well-formed, real calendar date', () => {
    expect(isValidCalendarDate('2026-08-15')).toBe(true);
  });

  it('accepts February 29 on a leap year', () => {
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
  });

  it('rejects February 29 on a non-leap year', () => {
    expect(isValidCalendarDate('2026-02-29')).toBe(false);
  });

  it('rejects February 30 — the exact bug this closes (JS Date silently rolls it to March 2)', () => {
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
  });

  it('rejects April 31 (a 30-day month)', () => {
    expect(isValidCalendarDate('2026-04-31')).toBe(false);
  });

  it('rejects month 00 and month 13', () => {
    expect(isValidCalendarDate('2026-00-15')).toBe(false);
    expect(isValidCalendarDate('2026-13-15')).toBe(false);
  });

  it('rejects day 00', () => {
    expect(isValidCalendarDate('2026-08-00')).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isValidCalendarDate('2026/08/15')).toBe(false);
    expect(isValidCalendarDate('26-08-15')).toBe(false);
    expect(isValidCalendarDate('2026-08-15T00:00:00Z')).toBe(false);
    expect(isValidCalendarDate('not-a-date')).toBe(false);
    expect(isValidCalendarDate('')).toBe(false);
  });
});
