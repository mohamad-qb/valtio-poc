import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateInDays, daysUntil } from "@shared/lib/date.ts";

/** Expiry Days bounds (REVIEW §2.4) and the smaller date findings: years 0000–0099, impossible dates. */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 6, 12, 0, 0)); // local noon, 2026-10-06
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dateInDays: out of range", () => {
  it("is empty, not a throw, for a number of days too far away", () => {
    for (const days of [1e9, -1e9, 3e6, -3e6, 100_001, -100_001, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(() => dateInDays(days)).not.toThrow();
      expect(dateInDays(days)).toBe("");
    }
  });

  it("is empty for anything but a finite number, as before", () => {
    for (const days of [NaN, Infinity, -Infinity, "5", null, undefined]) expect(dateInDays(days)).toBe("");
  });

  it("works up to 100000 days either way, always with a 4-digit year", () => {
    for (const days of [0, 1, -1, 365, 100_000, -100_000]) {
      const date = dateInDays(days);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(daysUntil(date)).toBe(days);
    }
    expect(dateInDays(0)).toBe("2026-10-06");
  });
});

describe("daysUntil", () => {
  it("reads years 0000-0099 as written, not as 19xx", () => {
    expect(daysUntil("0050-06-15")).toBeLessThan(-700_000);
    expect(daysUntil("0100-01-01") - daysUntil("0099-12-31")).toBe(1); // consecutive days
    expect(daysUntil("0001-01-01") - daysUntil("0000-12-31")).toBe(1);
  });

  it("is NaN for a date that doesn't exist (the schema flags the date itself)", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-00"]) {
      expect(daysUntil(date)).toBeNaN();
    }
    expect(daysUntil("2028-02-29")).toBe(daysUntil("2028-03-01") - 1); // a leap day is real
  });

  it("is NaN when empty or not an ISO date, as before", () => {
    for (const date of ["", "soon", "2026-10", 20261006 as unknown as string]) expect(daysUntil(date)).toBeNaN();
    expect(daysUntil("2026-10-07")).toBe(1);
  });
});
