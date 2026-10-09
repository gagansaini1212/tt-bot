// Server-only: HTX's signature version 2, which signs a private REST request
// with HmacSHA256 over its canonical form. It is self-contained, so a shared
// signer interface can wrap it. See docs/venues/htx.md.
import { createHmac } from "node:crypto";

/**
 * A request to sign. The HTX adapter only reads, so only GET requests are
 * signed: HTX signs a POST's auth parameters but not its body, and nothing
 * here sends one.
 */
export type HtxRequestToSign = {
  host: string;
  path: string;
  parameters: Readonly<Record<string, string>>;
  /** When the request is sent, by HTX's clock. */
  time: number;
};

export type HtxSigner = {
  /**
   * The request's query string: its parameters and HTX's auth parameters in
   * canonical order, then the Signature.
   */
  sign(request: HtxRequestToSign): string;
};

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
export function htxPreSignedText(host: string, path: string, query: string) {
  return ["GET", host.toLowerCase(), path, query].join("\n");
}

/**
 * Signature version 2 for one API key: HTX's Access Key and Secret Key. The
 * secret never leaves the signer.
 */
export function htxSignatureV2(credentials: {
  accessKey: string;
  secretKey: string;
}): HtxSigner {
  const { accessKey, secretKey } = credentials;
  if (!accessKey.trim() || !secretKey.trim())
    throw new Error(
      "An HTX access key and secret key are required in the execution service.",
    );
  return {
    sign({ host, path, parameters, time }) {
      const query = htxCanonicalQuery({
        ...parameters,
        AccessKeyId: accessKey,
        SignatureMethod: "HmacSHA256",
        SignatureVersion: "2",
        Timestamp: htxTimestamp(time),
      });
      // The raw digest in base64, not its hex.
      const signature = createHmac("sha256", secretKey)
        .update(htxPreSignedText(host, path, query))
        .digest("base64");
      return `${query}&Signature=${encode(signature)}`;
    },
  };
}
