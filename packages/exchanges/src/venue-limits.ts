// Server-only: what the worker tracks about a venue's limits and clock, kept
// apart per venue and per exchange account (ADR 0009 §5, issue #22). A rate
// limit, clock-skew error or outage on one venue never pauses, delays or
// slows requests to another, and an account's own limits never hold up
// another account on the same venue.

/**
 * Holds requests back until a Retry-After time passes. A venue has one for
 * the limits it applies to everything the worker sends, such as Binance's
 * request weight per IP, and each exchange account one for the limits the
 * venue counts per account, such as Binance's order count.
 */
export class Backoff {
  readonly #now: () => number;
  #until = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Whole seconds left to wait, or 0 when requests may go. */
  remainingSeconds(): number {
    const left = this.#until - this.#now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Waits at least `seconds` from now. An earlier time never shortens it. */
  hold(seconds: number) {
    this.#until = Math.max(this.#until, this.#now() + seconds * 1000);
  }
}

/**
 * The offset between this machine's clock and a venue's, shared by every
 * client of the venue: the venue's time is the same for all its accounts.
 * It is read again once a minute, or at once after a clock-skew error.
 */
export class VenueClock {
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  #offset = 0;
  #syncedAt = -Infinity;
  #sync?: Promise<void>;

  constructor(now: () => number = Date.now, { maxAgeMs = 60_000 } = {}) {
    this.#now = now;
    this.#maxAgeMs = maxAgeMs;
  }

  /** Milliseconds the venue's clock is ahead of this machine's. */
  get offset() {
    return this.#offset;
  }

  /** The venue's time now, as far as the last sync knows. */
  now() {
    return this.#now() + this.#offset;
  }

  /**
   * Reads the venue's time with `serverTime` unless a recent read is still
   * good. Concurrent callers share one read, and a failed read is retried
   * by the next caller.
   */
  async sync(serverTime: () => Promise<number>) {
    if (this.#now() - this.#syncedAt < this.#maxAgeMs) return;
    this.#sync ??= (async () => {
      const start = this.#now();
      const time = await serverTime();
      this.#offset = time - Math.floor((start + this.#now()) / 2);
      this.#syncedAt = this.#now();
    })().finally(() => {
      this.#sync = undefined;
    });
    await this.#sync;
  }

  /** After a clock-skew error: the next signed request syncs first. */
  invalidate() {
    this.#syncedAt = -Infinity;
  }
}

/**
 * One venue's shared state: the backoff for limits it applies to the whole
 * worker, and its clock. The venue registry makes one per venue and hands
 * it to every client of that venue, public or an account's; nothing in it
 * touches another venue's.
 */
export class VenueLimits {
  readonly venue: string;
  readonly backoff: Backoff;
  readonly clock: VenueClock;

  constructor({
    venue,
    now = Date.now,
  }: {
    venue: string;
    now?: () => number;
  }) {
    this.venue = venue;
    this.backoff = new Backoff(now);
    this.clock = new VenueClock(now);
  }
}
