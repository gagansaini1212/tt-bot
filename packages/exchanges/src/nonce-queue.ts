// Server-only: strictly increasing nonces for venues that require them, such
// as Kraken, whose private API refuses a nonce not greater than the last one
// the key used ("EAPI:Invalid nonce"). Two requests signed at once can reach
// the venue in either order, so an account's nonce venue gets one signed
// request at a time (ADR 0009 §6, issue #21).

// BigInt() rather than literals: the web app's build targets ES2017.
const ONE = BigInt(1);
const MICROSECONDS_PER_MILLISECOND = BigInt(1000);

/** One turn to send a signed request: its nonce, and the end of the turn. */
export type NonceTurn = {
  nonce: bigint;
  /** Ends the turn, whether the request succeeded or not. */
  release(): Promise<void>;
};

/**
 * Keeps an exchange account's last nonce. `next` waits until the caller is
 * the only one sending for the account, then issues a nonce greater than
 * every one issued before and at least `floor`. Another caller waits until
 * the turn is released. A store shared by worker processes, such as
 * PostgreSQL's, also persists the last nonce across restarts.
 */
export interface NonceStore {
  next(floor: bigint): Promise<NonceTurn>;
}

/**
 * Keeps the last nonce in memory, for one process. Its turns are exclusive
 * within the process only.
 */
export class MemoryNonceStore implements NonceStore {
  #last = BigInt(0);
  #turn: Promise<void> = Promise.resolve();

  get last() {
    return this.#last;
  }

  async next(floor: bigint): Promise<NonceTurn> {
    const previous = this.#turn;
    let release!: () => void;
    this.#turn = new Promise((resolve) => (release = resolve));
    await previous;
    this.#last = this.#last + ONE > floor ? this.#last + ONE : floor;
    return { nonce: this.#last, release: async () => release() };
  }
}

/**
 * An exchange account's queue of signed requests for a nonce venue. Each
 * `run` waits for the requests queued before it to finish, then sends with
 * the account's next nonce: never one used before, and at least the current
 * time in microseconds, so a lost store still moves forward. One queue per
 * account; the venue registry's connector keeps it with the account's
 * client.
 *
 * A request that fails still used its nonce. A nonce error on an order is
 * an unknown outcome like any other: reconcile before retrying it.
 */
export class NonceQueue {
  readonly #store: NonceStore;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor({
    store = new MemoryNonceStore(),
    now = Date.now,
  }: { store?: NonceStore; now?: () => number } = {}) {
    this.#store = store;
    this.#now = now;
  }

  run<T>(send: (nonce: bigint) => Promise<T>): Promise<T> {
    const turn = async () => {
      const { nonce, release } = await this.#store.next(
        BigInt(Math.floor(this.#now())) * MICROSECONDS_PER_MILLISECOND,
      );
      try {
        return await send(nonce);
      } finally {
        await release();
      }
    };
    const run = this.#queue.then(turn, turn);
    this.#queue = run.catch(() => {});
    return run;
  }
}
