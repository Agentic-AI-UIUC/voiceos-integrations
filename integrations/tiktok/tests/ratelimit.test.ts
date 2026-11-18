import { describe, expect, test } from "bun:test";
import { TokenBucket, createLimits } from "../src/ratelimit.ts";
import type { Clock } from "../src/types.ts";

class FakeClock implements Clock {
  t = 1_000_000;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

const drain = (b: TokenBucket) => {
  let n = 0;
  while (b.tryTake()) n++;
  return n;
};

describe("TokenBucket", () => {
  test("a full bucket allows perMinute takes, then refuses without consuming", () => {
    const b = new TokenBucket(6, new FakeClock());
    for (let i = 0; i < 6; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.tryTake()).toBe(false);
  });

  test("msUntilNext is 0 with a token free, else the wait until one comes back", () => {
    const c = new FakeClock();
    const b = new TokenBucket(6, c);
    expect(b.msUntilNext()).toBe(0);
    drain(b);
    expect(b.msUntilNext()).toBe(60_000);
    c.t += 59_999;
    expect(b.msUntilNext()).toBe(1);
    expect(b.tryTake()).toBe(false);
    c.t += 1;
    expect(b.msUntilNext()).toBe(0);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
  });

  test("never more than perMinute takes in any rolling minute (TikTok counts per minute)", () => {
    const c = new FakeClock();
    const b = new TokenBucket(6, c);
    const taken: number[] = [];
    for (let i = 0; i < 3_000; i++) {
      c.t += (i * 7_919) % 4_000;
      if (b.tryTake()) taken.push(c.t);
    }
    expect(taken.length).toBeGreaterThan(60);
    for (const t of taken) expect(taken.filter((x) => x > t - 60_000 && x <= t).length).toBeLessThanOrEqual(6);
  });

  test("a burst of 7 write inits in a minute: the 7th is refused", () => {
    const c = new FakeClock();
    const b = new TokenBucket(6, c);
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push(b.tryTake());
      c.t += 5_000;
    }
    expect(results).toEqual([true, true, true, true, true, true, false]);
    expect(b.msUntilNext()).toBe(25_000);
  });

  test("a clock that jumps backwards can't block for more than a minute", () => {
    const c = new FakeClock();
    const b = new TokenBucket(2, c);
    drain(b);
    c.t -= 3_600_000;
    expect(b.msUntilNext()).toBeLessThanOrEqual(60_000);
    c.t += 60_000;
    expect(b.tryTake()).toBe(true);
  });

  test("rejects a rate that isn't a positive integer", () => {
    const c = new FakeClock();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new TokenBucket(bad, c)).toThrow();
  });
});

describe("createLimits (plan §5.6)", () => {
  test("creator info 20, write inits 6 (shared by all four writes), status 25 per minute", () => {
    const l = createLimits(new FakeClock());
    expect(drain(l.creatorInfo)).toBe(20);
    expect(drain(l.writeInit)).toBe(6);
    expect(drain(l.status)).toBe(25);
  });

  test("the buckets are independent", () => {
    const l = createLimits(new FakeClock());
    drain(l.writeInit);
    expect(l.writeInit.tryTake()).toBe(false);
    expect(l.creatorInfo.tryTake()).toBe(true);
    expect(l.status.tryTake()).toBe(true);
  });
});
