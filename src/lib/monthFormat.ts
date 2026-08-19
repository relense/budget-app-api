const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validates the bare "YYYY-MM" convention plan.md uses for every month string in the schema. */
export function isValidMonthFormat(month: string): boolean {
  return MONTH_REGEX.test(month);
}

/** Formats a Date as the "YYYY-MM" convention, in UTC (matches how month strings are stored/compared everywhere else — no local-timezone drift). */
export function formatMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
