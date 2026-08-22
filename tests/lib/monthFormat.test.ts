import { describe, expect, it } from '@jest/globals';
import { addMonths, formatMonth, isValidMonthFormat, resolveDueDate } from '../../src/lib/monthFormat.js';

describe('isValidMonthFormat', () => {
  it('accepts a well-formed YYYY-MM string', () => {
    expect(isValidMonthFormat('2026-08')).toBe(true);
    expect(isValidMonthFormat('2030-01')).toBe(true);
  });

  it.each([
    'banana',
    '2026/08',
    '2026-8',
    '26-08',
    '2026-08-01',
    '2026-13',
    '',
    ' 2026-08',
    '2026-08 ',
  ])('rejects %p', (input) => {
    expect(isValidMonthFormat(input)).toBe(false);
  });
});

describe('formatMonth', () => {
  it('formats a Date as YYYY-MM in UTC, zero-padded', () => {
    expect(formatMonth(new Date('2026-08-15T12:00:00.000Z'))).toBe('2026-08');
    expect(formatMonth(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });

  it('uses UTC rather than the local timezone, even right at a month boundary', () => {
    // 2026-08-31T23:30 UTC is still August in UTC, whatever the local
    // timezone the test runner happens to be in would say.
    expect(formatMonth(new Date('2026-08-31T23:30:00.000Z'))).toBe('2026-08');
  });
});

describe('addMonths', () => {
  it('shifts forward within the same year', () => {
    expect(addMonths('2026-08', 1)).toBe('2026-09');
    expect(addMonths('2026-08', 2)).toBe('2026-10');
  });

  it('rolls over into the next year', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });

  it('shifts backward, including rolling into the previous year', () => {
    expect(addMonths('2026-08', -1)).toBe('2026-07');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('a delta of 0 returns the same month', () => {
    expect(addMonths('2026-08', 0)).toBe('2026-08');
  });
});

describe('resolveDueDate', () => {
  it('combines a month and day into a UTC date', () => {
    expect(resolveDueDate('2026-08', 15)).toEqual(new Date('2026-08-15T00:00:00.000Z'));
  });

  it('clamps a day past the end of a short month to that month\'s last day', () => {
    expect(resolveDueDate('2026-02', 31)).toEqual(new Date('2026-02-28T00:00:00.000Z'));
  });

  it('clamps into a leap-year February correctly', () => {
    expect(resolveDueDate('2028-02', 30)).toEqual(new Date('2028-02-29T00:00:00.000Z'));
  });

  it('does not clamp a day that fits within the month', () => {
    expect(resolveDueDate('2026-04', 30)).toEqual(new Date('2026-04-30T00:00:00.000Z'));
    expect(resolveDueDate('2026-01', 31)).toEqual(new Date('2026-01-31T00:00:00.000Z'));
  });
});
