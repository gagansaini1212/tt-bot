// Server-only: HTX's signature version 2, which signs a private REST request
// with HmacSHA256 over its canonical form, as a RequestSigner (ADR 0010).
// See docs/venues/htx.md.
import {
  CredentialsError,
  hmac,
  type RequestSigner,
  type SigningCredentials,
} from "./signing";

/** HTX's Timestamp parameter: UTC to the second, as YYYY-MM-DDThh:mm:ss. */
export function htxTimestamp(time: number): string {
  return new Date(time).toISOString().slice(0, 19);
}

// UTF-8 percent-encoding with upper-case hex, as HTX asks: a space is %20,
// never +, and only letters, digits and -_.~ stay as they are.
function encode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The parameters URL-encoded, ordered by name in ASCII order, joined by &. */
export function htxCanonicalQuery(
  parameters: Readonly<Record<string, string>>,
): string {
  return Object.entries(parameters)
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** What HTX signs: the method, lowercase host, path and canonical query, one per line. */
export function htxPreSignedText(
  host: string,
  path: string,
  query: string,
  method = "GET",
) {
  return [method.toUpperCase(), host.toLowerCase(), path, query].join("\n");
}

/**
 * HTX's signature version 2 for one API key: its Access Key and Secret Key,
 * as `hmac` credentials. It adds AccessKeyId, SignatureMethod,
 * SignatureVersion and the venue-corrected Timestamp to the query, puts the
 * query in canonical order, and appends the base64 HmacSHA256 of the
 * pre-signed text as Signature.
 */
export function htxRequestSigner(
  credentials: SigningCredentials,
): RequestSigner {
  if (credentials.kind !== "hmac")
    throw new CredentialsError(
      "HTX keys sign with a secret key (HMAC), not a private key.",
    );
  if (credentials.passphrase !== undefined)
    throw new CredentialsError("HTX takes no passphrase.");
  const { apiKey, secret } = credentials;
  if (!apiKey.trim() || !secret.trim())
    throw new CredentialsError("HTX keys need an access key and a secret key.");
  return {
    scheme: "htx-v2",
    sign(request) {
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "POST")
        throw new Error(
          `The HTX signer supports GET and POST requests only (received ${method}).`,
        );
      const url = new URL(request.url);
      const query = htxCanonicalQuery({
        ...Object.fromEntries(url.searchParams),
        AccessKeyId: apiKey,
        SignatureMethod: "HmacSHA256",
        SignatureVersion: "2",
        Timestamp: htxTimestamp(request.timestamp),
      });
      // The raw digest in base64, not its hex.
      const signature = hmac(
        "sha256",
        secret,
        htxPreSignedText(url.host, url.pathname, query, method),
        "base64",
      );
      url.search = `${query}&Signature=${encode(signature)}`;
      return {
        url,
        headers: {
          ...request.headers,
          ...(request.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: request.body,
      };
    },
  };
}
