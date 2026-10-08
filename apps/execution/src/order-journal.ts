import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Order intents, one file per client ID, written before anything is sent to
 * Binance. An ID with a file is never submitted again, even after a restart.
 */
export class OrderJournal {
  readonly directory: string;

  constructor(directory = process.env.TESTNET_ORDER_JOURNAL_DIR) {
    this.directory = resolve(directory ?? ".testnet-orders");
  }

  #path(clientId: string) {
    if (!/^ct_[A-Za-z0-9_-]{1,33}$/.test(clientId))
      throw new Error("Order journal IDs must be ct_ client IDs.");
    return resolve(this.directory, `${clientId}.json`);
  }

  /** Records a new intent. Returns false if this ID was ever used before. */
  async reserve(clientId: string, record: object): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.#path(clientId), JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async update(clientId: string, record: object) {
    await writeFile(this.#path(clientId), JSON.stringify(record), {
      mode: 0o600,
    });
  }

  async read(clientId: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.#path(clientId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
