import { describe, expect, test } from "bun:test";
import { ago, agoShort, aspect, bytes, compact, duration, durationSpoken, exact, percent, postedLabel, shortDate, times } from "../src/format.ts";

// Noon UTC, so the local calendar date is the same in every time zone from UTC-11 to UTC+11.
const NOV_1 = Date.UTC(2026, 10, 1, 12, 0, 0);
const NOV_4 = Date.UTC(2026, 10, 4, 13, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("compact (plan §8.8, verification log K1)", () => {
  test("matches the tested table", () => {
    expect(compact(0)).toBe("0");
    expect(compact(7)).toBe("7");
    expect(compact(999)).toBe("999");
    expect(compact(1049)).toBe("1K");
    expect(compact(1234)).toBe("1.2K");
    expect(compact(12345)).toBe("12.3K");
    expect(compact(123456)).toBe("123K");
    expect(compact(999_499)).toBe("999K");
    expect(compact(999_500)).toBe("1M");
    expect(compact(1_200_000)).toBe("1.2M");
    expect(compact(999_950_000)).toBe("1B");
    expect(compact(1_234_567_890)).toBe("1.2B");
  });

  test("never prints NaN or Infinity", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(compact(v)).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

describe("exact (a post's breakdown)", () => {
  test("grouped whole numbers, compact again from ten million", () => {
    expect(exact(0)).toBe("0");
    expect(exact(86)).toBe("86");
    expect(exact(1310)).toBe("1,310");
    expect(exact(12_400.4)).toBe("12,400");
    expect(exact(9_999_999)).toBe("9,999,999");
    expect(exact(12_345_678)).toBe("12.3M");
  });
  test("not a number is a dash", () => {
    for (const v of [Number.NaN, undefined as unknown as number]) expect(exact(v)).toBe("—");
  });
});

describe("times (vs your average)", () => {
  test("one decimal under 10, whole above", () => {
    expect(times(2.14)).toBe("2.1×");
    expect(times(4.03)).toBe("4×");
    expect(times(9.96)).toBe("10×");
    expect(times(12.6)).toBe("13×");
    expect(times(0)).toBe("");
    expect(times(Number.NaN)).toBe("");
  });
});

describe("percent (engagement on the cards)", () => {
  test("one decimal under 10%, whole numbers above, a floor for tiny rates", () => {
    expect(percent(0.0773)).toBe("7.7%");
    expect(percent(0.06)).toBe("6%");
    expect(percent(0.0996)).toBe("10%");
    expect(percent(0.1249)).toBe("12%");
    expect(percent(1.5)).toBe("150%");
    expect(percent(0.0004)).toBe("<0.1%");
    expect(percent(0)).toBe("0%");
  });
  test("not a rate → empty, never NaN%", () => {
    for (const v of [Number.NaN, -0.1, Number.POSITIVE_INFINITY, undefined as unknown as number]) expect(percent(v)).toBe("");
  });
});

describe("duration", () => {
  test("cards read m:ss or h:mm:ss", () => {
    expect(duration(0)).toBe("0:00");
    expect(duration(23)).toBe("0:23");
    expect(duration(65)).toBe("1:05");
    expect(duration(600)).toBe("10:00");
    expect(duration(3723)).toBe("1:02:03");
  });

  test("rounds fractional seconds from the MP4 reader", () => {
    expect(duration(23.4)).toBe("0:23");
    expect(duration(59.6)).toBe("1:00");
  });

  test("missing or invalid is empty", () => {
    expect(duration(undefined)).toBe("");
    expect(duration(Number.NaN)).toBe("");
    expect(duration(-5)).toBe("");
  });
});

describe("durationSpoken", () => {
  test("reads naturally aloud (plan §8.8)", () => {
    expect(durationSpoken(1)).toBe("1 second");
    expect(durationSpoken(23)).toBe("23 seconds");
    expect(durationSpoken(65)).toBe("1 minute 5 seconds");
    expect(durationSpoken(120)).toBe("2 minutes");
    expect(durationSpoken(3600)).toBe("1 hour");
    expect(durationSpoken(3723)).toBe("1 hour 2 minutes 3 seconds");
    expect(durationSpoken(0)).toBe("0 seconds");
    expect(durationSpoken(undefined)).toBe("");
  });
});

describe("bytes (decimal units, as Finder shows them)", () => {
  test("formats sizes", () => {
    expect(bytes(0)).toBe("0 bytes");
    expect(bytes(1)).toBe("1 byte");
    expect(bytes(812)).toBe("812 bytes");
    expect(bytes(1000)).toBe("1 KB");
    expect(bytes(12_400_000)).toBe("12.4 MB");
    expect(bytes(18_234_567)).toBe("18.2 MB");
    expect(bytes(123_456_789)).toBe("123 MB");
    expect(bytes(1_234_567_890)).toBe("1.2 GB");
    expect(bytes(4_000_000_000)).toBe("4 GB");
  });

  test("rolls over to the next unit instead of printing 1000 KB", () => {
    expect(bytes(999_999)).toBe("1 MB");
    expect(bytes(999_960_000)).toBe("1 GB");
  });

  test("invalid is empty", () => {
    expect(bytes(Number.NaN)).toBe("");
    expect(bytes(-1)).toBe("");
  });
});

describe("ago", () => {
  const now = NOV_4;
  test("relative times", () => {
    expect(ago(now - 10 * SEC, now)).toBe("just now");
    expect(ago(now - 59 * SEC, now)).toBe("just now");
    expect(ago(now - 60 * SEC, now)).toBe("1 min ago");
    expect(ago(now - 150 * SEC, now)).toBe("2 min ago");
    expect(ago(now - 59 * MIN, now)).toBe("59 min ago");
    expect(ago(now - HOUR, now)).toBe("1 hour ago");
    expect(ago(now - 3 * HOUR, now)).toBe("3 hours ago");
    expect(ago(now - (23 * HOUR + 59 * MIN), now)).toBe("23 hours ago");
    expect(ago(now - DAY, now)).toBe("1 day ago");
    expect(ago(now - 3 * DAY, now)).toBe("3 days ago");
    expect(ago(now - 45 * DAY, now)).toBe("1 month ago");
    expect(ago(now - 200 * DAY, now)).toBe("6 months ago");
    expect(ago(now - 400 * DAY, now)).toBe("1 year ago");
    expect(ago(now - 800 * DAY, now)).toBe("2 years ago");
  });

  test("a clock that runs ahead never says 'in the future'", () => {
    expect(ago(now + 5 * MIN, now)).toBe("just now");
  });

  test("invalid input is empty", () => {
    expect(ago(Number.NaN, now)).toBe("");
  });
});

describe("agoShort (narrow rows)", () => {
  const now = NOV_4;
  test("minutes, hours and days, then the date", () => {
    expect(agoShort(now - 30 * SEC, now)).toBe("just now");
    expect(agoShort(now - 12 * MIN, now)).toBe("12m ago");
    expect(agoShort(now - 3 * HOUR, now)).toBe("3h ago");
    expect(agoShort(now - 2 * DAY, now)).toBe("2d ago");
    expect(agoShort(now - 6 * DAY - 23 * HOUR, now)).toBe("6d ago");
    expect(agoShort(NOV_4 - 7 * DAY, now)).toBe(shortDate(NOV_4 - 7 * DAY, now));
    expect(agoShort(now + 5 * MIN, now)).toBe("just now");
    expect(agoShort(Number.NaN, now)).toBe("");
  });
});

describe("shortDate and postedLabel", () => {
  test("month and day, with the year only when it isn't this year", () => {
    expect(shortDate(NOV_1, NOV_4)).toBe("Nov 1");
    expect(shortDate(Date.UTC(2024, 10, 1, 12), NOV_4)).toBe("Nov 1, 2024");
    expect(shortDate(Number.NaN)).toBe("");
  });

  test("posted label combines both (plan §6.3)", () => {
    expect(postedLabel(NOV_1 / 1000, NOV_4)).toBe("Nov 1 · 3 days ago");
    expect(postedLabel(Number.NaN, NOV_4)).toBe("");
  });
});

describe("aspect", () => {
  test("common shapes", () => {
    expect(aspect(1080, 1920)).toBe("9:16");
    expect(aspect(720, 1280)).toBe("9:16");
    expect(aspect(1920, 1080)).toBe("16:9");
    expect(aspect(1080, 1080)).toBe("1:1");
    expect(aspect(1080, 1350)).toBe("4:5");
    expect(aspect(2880, 1800)).toBe("16:10");
  });

  test("near-misses from encoders snap to the common shape", () => {
    expect(aspect(1080, 1918)).toBe("9:16");
  });

  test("unknown or degenerate sizes give undefined", () => {
    expect(aspect(undefined, 1920)).toBeUndefined();
    expect(aspect(0, 0)).toBeUndefined();
    expect(aspect(1000, 1)).toBeUndefined();
    expect(aspect(1179, 2556)).toBeUndefined();
  });
});
