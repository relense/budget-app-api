const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validates the bare "YYYY-MM" convention PLAN.md uses for every month string in the schema. */
export function isValidMonthFormat(month: string): boolean {
  return MONTH_REGEX.test(month);
}

/** Formats a Date as the "YYYY-MM" convention, in UTC (matches how month strings are stored/compared everywhere else — no local-timezone drift). */
export function formatMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Shifts a "YYYY-MM" string by `delta` calendar months (negative to go back), rolling over the year as needed. Assumes an already-validated month string. */
export function addMonths(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const totalMonths = year * 12 + (mon - 1) + delta;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, '0')}`;
}
