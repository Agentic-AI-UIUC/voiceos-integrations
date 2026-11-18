/**
 * Client-side rate limits (plan §5.6; Studio brief "Rate limits"), so we refuse locally with RATE_LIMITED
 * instead of spending one of TikTok's per-minute requests on a call that would be rejected.
 *
 * Each bucket holds `perMinute` tokens and every spent token comes back exactly 60 s after it was spent
 * (a sliding-window bucket). A classic refill-rate bucket would let a full burst plus a minute's refill
 * through inside one rolling minute (6 + 5 = 11 inits), which TikTok's "6 per minute" would reject; this
 * one never allows more than `perMinute` takes in any 60 s window.
 */
import type { Clock } from "./types.ts";

const WINDOW_MS = 60_000;

export class TokenBucket {
  private readonly perMinute: number;
  private readonly clock: Clock;
  /** When each spent token was taken, oldest first. */
  private readonly spent: number[] = [];

  constructor(perMinute: number, clock: Clock) {
    if (!Number.isInteger(perMinute) || perMinute < 1) throw new RangeError(`perMinute must be a positive integer, got ${perMinute}`);
    this.perMinute = perMinute;
    this.clock = clock;
  }

  /** Takes a token if one is free. False when the bucket is empty (nothing is consumed). */
  tryTake(): boolean {
    const now = this.prune();
    if (this.spent.length >= this.perMinute) return false;
    this.spent.push(now);
    return true;
  }

  /** 0 when a token is free; otherwise how long until the oldest spent token comes back (≤ 60 s). */
  msUntilNext(): number {
    const now = this.prune();
    if (this.spent.length < this.perMinute) return 0;
    return Math.min(WINDOW_MS, Math.max(0, this.spent[0] + WINDOW_MS - now));
  }

  private prune(): number {
    const now = this.clock.now();
    // A clock that jumped backwards: treat those takes as happening now, so nothing blocks for more than a minute.
    for (let i = 0; i < this.spent.length; i++) if (this.spent[i] > now) this.spent[i] = now;
    while (this.spent.length && now - this.spent[0] >= WINDOW_MS) this.spent.shift();
    return now;
  }
}

/**
 * TikTok's limits, per user token: creator info 20/min; upload/post init 6/min, shared by all four write
 * tools (video drafts, video direct, photo drafts, photo direct); post status 30/min, kept to 25.
 * Reads (600/min) need no bucket.
 */
export function createLimits(clock: Clock): { creatorInfo: TokenBucket; writeInit: TokenBucket; status: TokenBucket } {
  return {
    creatorInfo: new TokenBucket(20, clock),
    writeInit: new TokenBucket(6, clock),
    status: new TokenBucket(25, clock),
  };
}
