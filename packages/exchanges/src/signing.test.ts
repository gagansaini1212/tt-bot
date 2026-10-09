import assert from "node:assert/strict";
import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { test } from "node:test";
import {
  binanceRequestSigner,
  credentialsFromKeys,
  CredentialsError,
  es256Jwt,
  hmac,
  signingKey,
  type RequestSigner,
  type SigningRequest,
  type SigningCredentials,
} from "./signing";

const pem = (
  type: "ed25519" | "rsa" | "ec",
  options: Record<string, unknown> = {},
) =>
  generateKeyPairSync(type as "ed25519", options)
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

const request = (overrides: Partial<SigningRequest> = {}): SigningRequest => ({
  method: "GET",
  url: new URL(
    "https://testnet.binance.vision/api/v3/account?omitZeroBalances=true",
  ),
  headers: {},
  timestamp: 1_800_000_000_123,
  ...overrides,
});

test("credentials take their kind from the keys, and may add a passphrase", () => {
  assert.deepEqual(
    credentialsFromKeys({ apiKey: " key ", apiSecret: "secret" }),
    { kind: "hmac", apiKey: "key", secret: "secret" },
  );
  assert.deepEqual(
    credentialsFromKeys({
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "phrase",
    }),
    { kind: "hmac", apiKey: "key", secret: "secret", passphrase: "phrase" },
  );
  for (const [type, kind, options] of [
    ["ed25519", "ed25519", {}],
    ["rsa", "rsa", { modulusLength: 2048 }],
    ["ec", "es256", { namedCurve: "prime256v1" }],
  ] as const) {
    const credentials = credentialsFromKeys({
      apiKey: "key",
      privateKey: `\n${pem(type, options)}\n`,
      passphrase: "phrase",
    });
    assert.equal(credentials.kind, kind, type);
    assert.equal(credentials.passphrase, "phrase");
  }
});

test("unusable credentials are refused without repeating them", () => {
  const refused = [
    { apiKey: "", apiSecret: "private-secret" },
    { apiKey: "key" },
    { apiKey: "key", apiSecret: "private-secret", privateKey: "private-pem" },
    { apiKey: "key", privateKey: "private-pem-content" },
    {
      apiKey: "key",
      privateKey: pem("rsa", { modulusLength: 1024 }),
    },
    {
      apiKey: "key",
      privateKey: pem("ec", { namedCurve: "secp384r1" }),
    },
  ];
  for (const keys of refused)
    assert.throws(
      () => credentialsFromKeys(keys),
      (error: unknown) =>
        error instanceof CredentialsError &&
        !/private-secret|private-pem|BEGIN/.test(error.message),
      JSON.stringify(Object.keys(keys)),
    );
});

test("Binance's HMAC signer signs the query as sent, with its timestamp and key header", () => {
  const signer = binanceRequestSigner({
    kind: "hmac",
    apiKey: "api-key",
    secret: "api-secret",
  });
  const signed = signer.sign(request());
  const query = new URLSearchParams(signed.url.search);
  const signature = query.get("signature");
  query.delete("signature");
  assert.equal(
    query.toString(),
    "omitZeroBalances=true&recvWindow=5000&timestamp=1800000000123",
  );
  assert.equal(
    signature,
    createHmac("sha256", "api-secret").update(query.toString()).digest("hex"),
  );
  assert.equal(signed.headers["X-MBX-APIKEY"], "api-key");
  assert.equal(signed.body, undefined);
  assert.equal(signer.scheme, "binance-hmac");
});

test("Binance's key-pair signers sign a form body in base64 that the public key verifies", () => {
  for (const [type, options] of [
    ["ed25519", {}],
    ["rsa", { modulusLength: 2048 }],
  ] as const) {
    const privateKey = pem(type, options);
    const signer = binanceRequestSigner(
      credentialsFromKeys({ apiKey: "api-key", privateKey }),
    );
    const signed = signer.sign(
      request({
        method: "POST",
        url: new URL("https://testnet.binance.vision/api/v3/order"),
        body: "symbol=BTCUSDT&side=BUY",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    assert.equal(signed.url.search, "");
    const parameters = new URLSearchParams(signed.body);
    const signature = parameters.get("signature")!;
    parameters.delete("signature");
    assert.equal(
      verify(
        type === "ed25519" ? null : "sha256",
        Buffer.from(parameters.toString()),
        createPublicKey(privateKey),
        Buffer.from(signature, "base64"),
      ),
      true,
      type,
    );
    assert.equal(
      signed.headers["Content-Type"],
      "application/x-www-form-urlencoded",
    );
  }
});

test("Binance takes neither a passphrase nor ES256 keys", () => {
  assert.throws(
    () =>
      binanceRequestSigner({
        kind: "hmac",
        apiKey: "key",
        secret: "secret",
        passphrase: "phrase",
      }),
    /no passphrase/,
  );
  assert.throws(
    () =>
      binanceRequestSigner(
        credentialsFromKeys({
          apiKey: "key",
          privateKey: pem("ec", { namedCurve: "prime256v1" }),
        }),
      ),
    /Ed25519 or RSA/,
  );
});

test("an ES256 JWT carries the venue's claims and verifies with the public key", () => {
  const privatePem = pem("ec", { namedCurve: "prime256v1" });
  const key = signingKey(privatePem, ["es256"]);
  const token = es256Jwt({
    privateKey: key,
    header: { kid: "organizations/x/apiKeys/y" },
    claims: {
      sub: "organizations/x/apiKeys/y",
      iss: "cdp",
      uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
    },
    now: 1_800_000_000_000,
  });
  const [header, payload, signature] = token.split(".");
  const decode = (part: string) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  assert.equal(decode(header).alg, "ES256");
  assert.equal(decode(header).kid, "organizations/x/apiKeys/y");
  assert.match(decode(header).nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(decode(payload), {
    nbf: 1_800_000_000,
    exp: 1_800_000_120,
    sub: "organizations/x/apiKeys/y",
    iss: "cdp",
    uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(privatePem), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  assert.throws(
    () =>
      es256Jwt({
        privateKey: signingKey(pem("ed25519"), ["ed25519"]),
        claims: {},
      }),
    /P-256/,
  );
});

test("a venue that signs the method, host, path and sorted query plugs in as a signer", () => {
  // Shaped like HTX's signature version 2, which its adapter will add: the
  // interface gives a signer everything such a scheme signs.
  const credentials: SigningCredentials = {
    kind: "hmac",
    apiKey: "access-key",
    secret: "secret-key",
  };
  const versionTwo: RequestSigner = {
    scheme: "example-v2",
    sign({ method, url, headers, timestamp }) {
      const signed = new URL(url);
      signed.searchParams.set("AccessKeyId", credentials.apiKey);
      signed.searchParams.set("SignatureMethod", "HmacSHA256");
      signed.searchParams.set("SignatureVersion", "2");
      signed.searchParams.set(
        "Timestamp",
        new Date(timestamp).toISOString().slice(0, 19),
      );
      signed.searchParams.sort();
      const payload = [
        method,
        signed.host,
        signed.pathname,
        signed.searchParams.toString(),
      ].join("\n");
      signed.searchParams.set(
        "Signature",
        hmac(
          "sha256",
          (credentials as { secret: string }).secret,
          payload,
          "base64",
        ),
      );
      return { url: signed, headers: { ...headers } };
    },
  };
  const signed = versionTwo.sign(
    request({
      url: new URL("https://api.example.com/v1/order/orders?symbol=btcusdt"),
    }),
  );
  assert.equal(signed.url.searchParams.get("Timestamp"), "2027-01-15T08:00:00");
  assert.ok(signed.url.searchParams.get("Signature"));
});
