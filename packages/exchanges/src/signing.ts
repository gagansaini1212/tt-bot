// Server-only: how the worker proves a request comes from an exchange
// account. Venues authenticate differently (ADR 0009, issue #21): an HMAC of
// the parameters, an HMAC with a passphrase header, a key pair's signature,
// or a JWT signed with ES256 for each request. Each venue's adapter takes a
// RequestSigner built from the account's credentials, so a new venue plugs
// in its own signer and reuses the primitives below.
//
// Credentials, signatures and signed tokens are as secret as the keys: never
// log, return or put them in an error message.
import {
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { ExchangeKeyType } from "./venues";

/**
 * One exchange account's credentials, as a venue's signer takes them. Their
 * kind is the account's key type (`ExchangeKeyType`):
 * - hmac: an API key and a shared secret.
 * - ed25519, rsa: an API key and the private key, as unencrypted PEM, whose
 *   public key is registered with the venue.
 * - es256: a key name and an EC P-256 private key, as unencrypted PEM, that
 *   signs a short-lived JWT for every request, as Coinbase's CDP keys do.
 * Any kind may add the passphrase that venues such as OKX and KuCoin send
 * with every request.
 */
export type SigningCredentials =
  | { kind: "hmac"; apiKey: string; secret: string; passphrase?: string }
  | {
      kind: Exclude<ExchangeKeyType, "hmac">;
      apiKey: string;
      privateKey: string;
      passphrase?: string;
    };

/** Credentials a venue cannot use. Its message never repeats them. */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

/**
 * Credentials from keys as the credential store and the worker's .env hold
 * them: an API key with either a secret or a PEM private key, and perhaps a
 * passphrase. A private key's kind comes from the key itself.
 */
export function credentialsFromKeys(keys: {
  apiKey: string;
  apiSecret?: string;
  privateKey?: string;
  passphrase?: string;
}): SigningCredentials {
  const apiKey = keys.apiKey.trim();
  const secret = keys.apiSecret?.trim();
  const pem = keys.privateKey?.trim();
  if (!apiKey || (!secret && !pem))
    throw new CredentialsError(
      "Credentials need an API key and either a secret or a private key.",
    );
  if (secret && pem)
    throw new CredentialsError(
      "Credentials hold either a secret or a private key, not both.",
    );
  const passphrase = keys.passphrase ? { passphrase: keys.passphrase } : {};
  if (secret) return { kind: "hmac", apiKey, secret, ...passphrase };
  const key = signingKey(`${pem}\n`, ["ed25519", "rsa", "es256"]);
  return {
    kind: keyKind(key),
    apiKey,
    privateKey: `${pem}\n`,
    ...passphrase,
  };
}

function keyKind(key: KeyObject): "ed25519" | "rsa" | "es256" {
  return key.asymmetricKeyType === "ec"
    ? "es256"
    : (key.asymmetricKeyType as "ed25519" | "rsa");
}

/**
 * Parses an unencrypted PEM private key of one of `kinds`. RSA keys need at
 * least 2048 bits, and ES256 keys the P-256 curve. Throws CredentialsError.
 */
export function signingKey(
  pem: string,
  kinds: readonly ("ed25519" | "rsa" | "es256")[],
): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new CredentialsError(
      "The private key must be an unencrypted PEM key.",
    );
  }
  const type = key.asymmetricKeyType;
  const usable =
    (type === "ed25519" && kinds.includes("ed25519")) ||
    (type === "rsa" &&
      kinds.includes("rsa") &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) ||
    (type === "ec" &&
      kinds.includes("es256") &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1");
  if (!usable)
    throw new CredentialsError(
      `The private key must be one of: ${kinds.map((kind) => KIND_NAMES[kind]).join(", ")}.`,
    );
  return key;
}

const KIND_NAMES = {
  ed25519: "Ed25519",
  rsa: "RSA of at least 2048 bits",
  es256: "EC P-256 (ES256)",
};

/** An HMAC of `payload`, as hex or base64. */
export function hmac(
  algorithm: "sha256" | "sha384" | "sha512",
  key: string | Buffer,
  payload: string | Buffer,
  encoding: "hex" | "base64",
): string {
  return createHmac(algorithm, key).update(payload).digest(encoding);
}

/**
 * Signs `payload` with a private key: Ed25519 as is, RSA with PKCS #1 v1.5
 * and SHA-256, and EC with SHA-256 in the fixed-length (r || s) form JWTs use.
 */
export function signPayload(key: KeyObject, payload: string | Buffer): Buffer {
  const data = Buffer.from(payload);
  switch (key.asymmetricKeyType) {
    case "ed25519":
      return sign(null, data, key);
    case "rsa":
      return sign("sha256", data, key);
    case "ec":
      return sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
    default:
      throw new CredentialsError("This private key cannot sign requests.");
  }
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

/**
 * A JWT signed with ES256 (RFC 7518), such as Coinbase's CDP keys need for
 * each request. `header` and `claims` are the venue's own; `nbf` and `exp`
 * are set from `now` unless given, and the header gets a random `nonce`.
 * The token is as secret as the key until it expires.
 */
export function es256Jwt({
  privateKey,
  header = {},
  claims,
  now = Date.now(),
  lifetimeSeconds = 120,
}: {
  privateKey: KeyObject;
  header?: Record<string, string>;
  claims: Record<string, string | number>;
  now?: number;
  lifetimeSeconds?: number;
}): string {
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new CredentialsError("ES256 needs an EC P-256 private key.");
  const issued = Math.floor(now / 1000);
  const signingInput = [
    base64url(
      JSON.stringify({
        alg: "ES256",
        typ: "JWT",
        nonce: randomBytes(16).toString("hex"),
        ...header,
      }),
    ),
    base64url(
      JSON.stringify({
        nbf: issued,
        exp: issued + lifetimeSeconds,
        ...claims,
      }),
    ),
  ].join(".");
  return `${signingInput}.${base64url(signPayload(privateKey, signingInput))}`;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** A request to a venue as its adapter built it, before it is signed. */
export type SigningRequest = {
  readonly method: HttpMethod;
  /** The venue's origin and path. Its search parameters are the query. */
  readonly url: URL;
  /** The body exactly as it will be sent, if the request has one. */
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Milliseconds since the epoch on the venue's clock: this machine's clock
   * corrected by the venue's offset (VenueClock).
   */
  readonly timestamp: number;
  /**
   * The account's next nonce, for venues that need strictly increasing
   * ones. NonceQueue issues it.
   */
  readonly nonce?: bigint;
};

/** What to send in place of the unsigned request. */
export type SignedRequest = {
  url: URL;
  body?: string;
  headers: Record<string, string>;
};

/**
 * Adds an exchange account's authentication to a request, in its venue's
 * scheme: the parameters, headers and signature the venue checks. It may
 * add parameters to the query or the body, such as a timestamp, and must
 * sign them exactly as they are sent. It never sends anything itself.
 *
 * Binance's is below. HTX's signature version 2 signs the method, host,
 * path and sorted query, and adds its own parameters to the query, which
 * `method`, `url` and `timestamp` carry. OKX adds a passphrase header,
 * Coinbase an ES256 JWT, and Kraken signs a nonce: the primitives in this
 * module cover each.
 */
export interface RequestSigner {
  /** The venue's name for the scheme, for logs and tests. */
  readonly scheme: string;
  sign(request: SigningRequest): SignedRequest;
}

// How long Binance accepts a signed request after its timestamp.
const BINANCE_RECV_WINDOW = "5000";

/**
 * Binance Spot's signed endpoints: `timestamp` and `recvWindow` are added to
 * the parameters, which are the query string for a request without a body
 * and the form body otherwise, and `signature` signs them as sent. HMAC keys
 * sign with HMAC-SHA256 in hex; Ed25519 and RSA keys sign in base64, which
 * the form encoding percent-encodes. The API key goes in `X-MBX-APIKEY`.
 * Binance takes neither a passphrase nor ES256 keys.
 */
export function binanceRequestSigner(
  credentials: SigningCredentials,
): RequestSigner {
  if (credentials.passphrase !== undefined)
    throw new CredentialsError("Binance takes no passphrase.");
  let signature: (payload: string) => string;
  if (credentials.kind === "hmac") {
    const { secret } = credentials;
    signature = (payload) => hmac("sha256", secret, payload, "hex");
  } else {
    let key: KeyObject;
    try {
      key = signingKey(credentials.privateKey, ["ed25519", "rsa"]);
    } catch {
      throw new CredentialsError(
        "The Binance private key must be an unencrypted Ed25519 or RSA PEM key. RSA keys must have at least 2048 bits.",
      );
    }
    signature = (payload) => signPayload(key, payload).toString("base64");
  }
  const { apiKey } = credentials;
  return {
    scheme: `binance-${credentials.kind}`,
    sign(request) {
      const url = new URL(request.url);
      const inBody = request.body !== undefined;
      const parameters = new URLSearchParams(
        inBody ? request.body : url.search,
      );
      parameters.set("recvWindow", BINANCE_RECV_WINDOW);
      parameters.set("timestamp", String(request.timestamp));
      parameters.set("signature", signature(parameters.toString()));
      const signed = parameters.toString();
      if (!inBody) url.search = signed;
      return {
        url,
        ...(inBody ? { body: signed } : {}),
        headers: { ...request.headers, "X-MBX-APIKEY": apiKey },
      };
    },
  };
}
