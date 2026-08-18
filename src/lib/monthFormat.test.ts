import { describe, expect, it } from '@jest/globals';
import { isValidMonthFormat } from './monthFormat.js';

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
