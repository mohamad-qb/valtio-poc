const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far from today `dateInDays` goes, either way: about 270 years, so its
 * date always has a 4-digit year. Further is no date at all.
 */
export const MAX_DAYS_FROM_TODAY = 100_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * UTC midnight of a calendar date; `NaN` for one that doesn't exist
 * (2026-02-30). `setUTCFullYear` takes years 0000–0099 as written, where
 * `Date.UTC` would read them as 19xx.
 */
const utcMidnight = (year: number, month: number, day: number) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const exists = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return exists ? date.getTime() : NaN;
};

const todayUtcMidnight = () => {
  const now = new Date();
  return utcMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
};

/**
 * Whole calendar days from today (local time) until an ISO `YYYY-MM-DD`
 * date; negative when it is in the past, `NaN` when empty, not an ISO date,
 * or a date that doesn't exist.
 */
export const daysUntil = (isoDate: unknown): number => {
  const match = typeof isoDate === "string" ? ISO_DATE.exec(isoDate) : null;
  if (!match) return NaN;
  // UTC midnights on both sides so DST shifts never skew the count
  const target = utcMidnight(Number(match[1]), Number(match[2]), Number(match[3]));
  return Math.round((target - todayUtcMidnight()) / MS_PER_DAY);
};

/**
 * The ISO `YYYY-MM-DD` date `days` whole days from today (local time): the
 * inverse of `daysUntil`. Empty unless `days` is a finite number at most
 * `MAX_DAYS_FROM_TODAY` either way.
 */
export const dateInDays = (days: unknown): string => {
  if (typeof days !== "number" || !Number.isFinite(days) || Math.abs(days) > MAX_DAYS_FROM_TODAY) return "";

  const now = new Date();
  // UTC midnight, as in daysUntil; the day rolls over months and years
  const target = new Date(0);
  target.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate() + Math.round(days));

  return target.toISOString().slice(0, 10);
};

/**
 * Whether ISO date `date` is on or after `reference`. ISO `YYYY-MM-DD`
 * strings compare correctly as strings; an empty date never fails.
 */
export const isOnOrAfter = (date: string, reference: string) =>
  !date || !reference || date >= reference;
