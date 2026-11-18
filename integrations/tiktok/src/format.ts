/**
 * Numbers, durations, sizes and dates, formatted the way the cards and the
 * spoken lines show them (plan §8.8). Pure functions: no I/O, no clock unless
 * one is passed in.
 */

/** 12.3K, 1.2M, 1B. Verified on Bun 1.3.14: the hand-rolled v2 version printed 999,500 as "1000K". */
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
  maximumFractionDigits: 1,
  roundingPriority: "lessPrecision",
} as Intl.NumberFormatOptions);

/** Same precision as `compact`, for sizes, without grouping so "1000" can be detected and rolled over. */
const SIZE = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
  maximumFractionDigits: 1,
  roundingPriority: "lessPrecision",
  useGrouping: false,
} as Intl.NumberFormatOptions);

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** <1000 as-is; then 1.2K, 12.3K, 123K, 1.2M, 1.2B. A non-number renders as an em dash, never "NaN". */
export function compact(n: number): string {
  return isNum(n) ? COMPACT.format(n) : "—";
}

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * The exact count, grouped, for a breakdown: 1310 → "1,310", 86 → "86". From ten million it
 * is compacted again ("12.3M"), so a cell never outgrows its column. Not a number → "—".
 */
export function exact(n: number): string {
  if (!isNum(n)) return "—";
  return Math.abs(n) >= 10_000_000 ? COMPACT.format(n) : GROUPED.format(Math.round(n));
}

/** A compact count with its noun: 1 → "1 video", 48 → "48 videos", 12300 → "12.3K videos". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${compact(n)} ${n === 1 ? one : many}`;
}

/**
 * A ratio as a short percentage, the way analytics screens show it:
 * 0.0773 → "7.7%", 0.1249 → "12%", 0.0004 → "<0.1%", 0 → "0%". Not a number or negative → "".
 */
export function percent(ratio: number): string {
  if (!isNum(ratio) || ratio < 0) return "";
  const p = ratio * 100;
  if (p === 0) return "0%";
  if (p < 0.1) return "<0.1%";
  const tenths = Math.round(p * 10) / 10;
  return tenths < 10 ? `${tenths}%` : `${Math.round(p)}%`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 23 → "0:23", 3723 → "1:02:03"; missing or negative → "". */
export function duration(sec?: number): string {
  if (!isNum(sec) || sec < 0) return "";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

const unit = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "23 seconds", "1 minute 5 seconds", "1 hour 2 minutes 3 seconds"; missing → "". */
export function durationSpoken(sec?: number): string {
  if (!isNum(sec) || sec < 0) return "";
  const total = Math.round(sec);
  if (total === 0) return "0 seconds";
  const parts: string[] = [];
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) parts.push(unit(h, "hour"));
  if (m) parts.push(unit(m, "minute"));
  if (s) parts.push(unit(s, "second"));
  return parts.join(" ");
}

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/** Decimal units, as Finder shows them: 812 bytes, 12.4 MB, 1.2 GB. */
export function bytes(n: number): string {
  if (!isNum(n) || n < 0) return "";
  if (n < 1000) {
    const whole = Math.round(n);
    return `${whole} ${whole === 1 ? "byte" : "bytes"}`;
  }
  let value = n / 1000;
  let i = 0;
  // Round first, then decide the unit, so 999,999 bytes reads "1 MB" rather than "1000 KB".
  while (i < SIZE_UNITS.length - 1 && Number(SIZE.format(value)) >= 1000) {
    value /= 1000;
    i += 1;
  }
  return `${SIZE.format(value)} ${SIZE_UNITS[i]}`;
}

/** "just now", "2 min ago", "3 hours ago", "3 days ago", "2 months ago", "1 year ago". */
export function ago(ms: number, now: number): string {
  if (!isNum(ms) || !isNum(now)) return "";
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${unit(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${unit(days, "day")} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${unit(months, "month")} ago`;
  return `${unit(Math.max(1, Math.floor(days / 365)), "year")} ago`;
}

/**
 * `ago` for a narrow column: "just now", "12m ago", "3h ago", "2d ago"; from a week on it is
 * the date instead ("Oct 30", or "Oct 30, 2024" in another year), which reads better than "5w".
 */
export function agoShort(ms: number, now: number): string {
  if (!isNum(ms) || !isNum(now)) return "";
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(ms, now);
}

/** How many times bigger: 2.14 → "2.1×", 12.6 → "13×". Not a positive number → "". */
export function times(ratio: number): string {
  if (!isNum(ratio) || ratio <= 0) return "";
  return ratio < 9.95 ? `${Math.round(ratio * 10) / 10}×` : `${Math.round(ratio)}×`;
}

/**
 * "Nov 1" in the Mac's local time zone (the server runs on the user's Mac);
 * "Nov 1, 2024" when it isn't the current year. `now` defaults to the clock.
 */
export function shortDate(ms: number, now: number = Date.now()): string {
  if (!isNum(ms)) return "";
  const date = new Date(ms);
  const sameYear = isNum(now) && date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** TikTok's create_time (UTC seconds) → "Nov 1 · 3 days ago". */
export function postedLabel(createTimeSec: number, now: number): string {
  if (!isNum(createTimeSec)) return "";
  const ms = createTimeSec * 1000;
  return `${shortDate(ms, now)} · ${ago(ms, now)}`;
}

/** Shapes people recognise, portrait and landscape. 16:10 is a Mac screen recording. */
const RATIOS: Array<[number, number]> = [
  [9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [16, 10], [10, 16], [21, 9], [9, 21],
];
const SNAP = Math.log(1.03); // within 3%: encoders round 1080x1920 to 1080x1918 and similar

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 1080×1920 → "9:16". Odd shapes with no short ratio give undefined (the card then shows the length alone). */
export function aspect(w?: number, h?: number): string | undefined {
  if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) return undefined;
  const r = Math.log(w / h);
  let best: [number, number] | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const ratio of RATIOS) {
    const diff = Math.abs(r - Math.log(ratio[0] / ratio[1]));
    if (diff < bestDiff) {
      best = ratio;
      bestDiff = diff;
    }
  }
  if (best && bestDiff <= SNAP) return `${best[0]}:${best[1]}`;
  const W = Math.round(w);
  const H = Math.round(h);
  const g = gcd(W, H) || 1;
  return W / g <= 32 && H / g <= 32 ? `${W / g}:${H / g}` : undefined;
}
