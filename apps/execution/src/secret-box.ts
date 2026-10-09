import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const FORMAT = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The environment variable holding the master key. It has no default. */
export const MASTER_KEY_VARIABLE = "CREDENTIALS_MASTER_KEY";

/**
 * Seals secrets the worker keeps in PostgreSQL, such as exchange keys and
 * webhook URLs, with AES-256-GCM. Every seal uses a fresh random nonce. The
 * `context` is bound in as associated data, so a sealed value opens only with
 * the same context: name the owner and purpose, such as the customer, the
 * exchange account and the column, and a value copied to another row fails
 * to open.
 *
 * A sealed value is one format byte, the 12-byte nonce, the ciphertext and
 * the 16-byte tag.
 */
export class SecretBox {
  readonly #key: Buffer;
  readonly #fingerprintKey: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES)
      throw new Error(`The master key must be ${KEY_BYTES} bytes.`);
    this.#key = Buffer.from(key);
    this.#fingerprintKey = Buffer.from(
      hkdfSync("sha256", this.#key, Buffer.alloc(0), "fingerprint", KEY_BYTES),
    );
  }

  /**
   * The box for the master key in `CREDENTIALS_MASTER_KEY`, or undefined
   * when it is not set. A set value that is not 32 bytes of base64 throws.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv): SecretBox | undefined {
    const value = env[MASTER_KEY_VARIABLE]?.trim();
    if (!value) return undefined;
    const key = Buffer.from(value, "base64");
    if (key.length !== KEY_BYTES || key.toString("base64") !== value)
      throw new Error(
        `${MASTER_KEY_VARIABLE} must be 32 random bytes in base64. Generate one with: openssl rand -base64 32`,
      );
    return new SecretBox(key);
  }

  seal(plaintext: string, context: readonly string[]): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(associatedData(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.of(FORMAT),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]);
  }

  /**
   * A keyed hash of `value` in `context`, to find a value saved twice
   * without storing it, such as one API key on two exchange accounts. It is
   * HMAC-SHA256 under a key derived from the master key for this use only,
   * so equal values in the same context give equal fingerprints, and nothing
   * else can be learned from one without the master key.
   */
  fingerprint(value: string, context: readonly string[]): Buffer {
    return createHmac("sha256", this.#fingerprintKey)
      .update(associatedData([...context, value]))
      .digest();
  }

  /** Throws if the value was changed, sealed with another key or context. */
  open(sealed: Uint8Array, context: readonly string[]): string {
    const value = Buffer.from(sealed);
    if (value.length < 1 + NONCE_BYTES + TAG_BYTES || value[0] !== FORMAT)
      throw new SecretBoxError();
    const nonce = value.subarray(1, 1 + NONCE_BYTES);
    const tag = value.subarray(value.length - TAG_BYTES);
    const ciphertext = value.subarray(1 + NONCE_BYTES, -TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretBoxError();
    }
  }
}

/** A sealed value that does not open. It never carries the value. */
export class SecretBoxError extends Error {
  constructor() {
    super(
      "A sealed secret could not be opened: it was changed, or sealed with another master key or for another owner.",
    );
    this.name = "SecretBoxError";
  }
}

// JSON keeps the parts apart, so ["a", "bc"] and ["ab", "c"] differ.
function associatedData(context: readonly string[]) {
  if (!context.length) throw new Error("A seal needs a context.");
  return Buffer.from(JSON.stringify(context), "utf8");
}
