const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validates the bare "YYYY-MM" convention plan.md uses for every month string in the schema. */
export function isValidMonthFormat(month: string): boolean {
  return MONTH_REGEX.test(month);
}
