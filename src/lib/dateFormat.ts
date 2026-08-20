const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validates the bare "YYYY-MM-DD" convention docs/PLAN.md's Dates section
 * uses for every calendar-date field — not just the shape, but that it's a
 * real calendar date. A regex-only check (`^\d{4}-\d{2}-\d{2}$`) lets
 * something like "2026-02-30" through, and `new Date('2026-02-30')`
 * silently rolls it over to 2026-03-02 instead of throwing — exactly the
 * "silently truncated or shifted value stored" PLAN.md's convention exists
 * to prevent. This round-trips the parsed components back through
 * Date.UTC and rejects anything that doesn't match exactly.
 */
export function isValidCalendarDate(date: string): boolean {
  const match = DATE_REGEX.exec(date);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr] = match as unknown as [string, string, string, string];
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) return false;
  // Date.UTC treats a 0-99 year as 1900+year (a JS spec quirk carried over
  // from two-digit years) — that would make the round-trip below never
  // match a genuinely 4-digit "0000"-"0099" input, rejecting an
  // otherwise-well-formed date. Not a real-world concern for this app's
  // domain (no budget month is ever year 0-99), but explicit here so it
  // reads as intentional over-rejection, not an overlooked bug.
  if (year < 100) return false;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}
