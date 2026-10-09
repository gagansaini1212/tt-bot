// A fake HTX spot API for tests: a fetch function that answers the endpoints
// the read-only adapter calls. Private endpoints answer with HTX's documented
// example responses, adapted to a few markets; public ones with market data
// recorded from HTX (./htx-samples). Every private request's signature
// version 2 is checked here independently of the adapter. Anything but a GET
// is answered with HTTP 405 and recorded in `refused`.
import { createHmac } from "node:crypto";
import { HTX_SAMPLES } from "./htx-samples";

const ORIGIN = "https://api.huobi.pro";
const SPOT_ACCOUNT = "10000001";
const MINUTE = 60_000;

export type FakeHtxRequest = {
  path: string;
  parameters: URLSearchParams;
  signed: boolean;
};

const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
  });
const ok = (data: string) => json(`{"status":"ok","data":${data}}`);
// Parsed JSON whose numbers serialize again exactly as they were written.
const rawNumbers = (text: string): unknown =>
  (
    JSON.parse as (
      text: string,
      reviver: (
        key: string,
        value: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown
  )(text, (_key, value, context) =>
    typeof value === "number"
      ? (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(
          context!.source!,
        )
      : value,
  );
const error = (code: string, message: string) =>
  json(
    `{"status":"error","err-code":"${code}","err-msg":"${message}","data":null}`,
  );

export class FakeHtx {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly requests: FakeHtxRequest[] = [];
  /** Requests that were not GETs. The adapter must never send one. */
  readonly refused: { method: string; path: string }[] = [];
  /** HTX's clock. */
  now: () => number;
  uid = "63628520";
  /** The API key's permissions, as GET /v2/user/api-key lists them. */
  permission = "readOnly";
  /** A sub-user's key, which HTX refuses on parent-only endpoints. */
  subUser = false;
  // Raw JSON, with numbers as HTX writes them.
  accounts = `[{"id":${SPOT_ACCOUNT},"type":"spot","subtype":"","state":"working"},{"id":10000003,"type":"point","subtype":"","state":"working"}]`;
  balances = [
    { currency: "usdt", type: "trade", balance: "91.850043797676510303" },
    { currency: "usdt", type: "frozen", balance: "5.160000000000000015" },
    { currency: "btc", type: "trade", balance: "0.00125" },
    { currency: "btc", type: "frozen", balance: "0.001" },
    { currency: "eth", type: "trade", balance: "0" },
    { currency: "eth", type: "frozen", balance: "0" },
    { currency: "poly", type: "trade", balance: "147.928994082840236" },
  ];
  /** Open orders, as GET /v1/order/openOrders lists them. */
  openOrders: string[];
  /** Orders by ID, as GET /v1/order/orders/{order-id} answers. */
  orders: Map<string, string>;
  /** Match results, as GET /v1/order/matchresults lists them. */
  fills: string[];
  #failures = new Map<string, (() => Response)[]>();

  constructor(
    options: { apiKey?: string; apiSecret?: string; now?: () => number } = {},
  ) {
    this.apiKey = options.apiKey ?? "e2xxxxxx-99xxxxxx-84xxxxxx-7xxxx";
    this.apiSecret = options.apiSecret ?? "fake-htx-secret";
    this.now = options.now ?? Date.now;
    const now = this.now();
    this.openOrders = [
      `{"symbol":"btcusdt","source":"spot-api","price":"60000.010000000000000000","created-at":${now - 30 * MINUTE},"amount":"0.002000000000000000","account-id":${SPOT_ACCOUNT},"filled-cash-amount":"60.00001","client-order-id":"ct_web_001","filled-amount":"0.001","filled-fees":"0.000002","id":357630527817871,"state":"partial-filled","type":"buy-limit"}`,
      // An order placed on HTX's website, with an ID a double cannot hold.
      `{"symbol":"ethusdt","source":"web","price":"4000.000000000000000000","created-at":${now - 20 * MINUTE},"amount":"0.500000000000000000","account-id":${SPOT_ACCOUNT},"filled-cash-amount":"0.0","client-order-id":"","filled-amount":"0.0","filled-fees":"0.0","id":9007199254740993,"state":"submitted","type":"sell-limit-maker"}`,
      `{"symbol":"xrpusdt","source":"web","price":"0.5","created-at":${now - 10 * MINUTE},"amount":"10","account-id":${SPOT_ACCOUNT},"filled-cash-amount":"0.0","client-order-id":"","filled-amount":"0.0","filled-fees":"0.0","id":357630527817999,"state":"submitted","type":"buy-limit"}`,
    ];
    // HTX's documented order lookup spells the filled amounts "field-…".
    this.orders = new Map([
      [
        "357632718898331",
        `{"id":357632718898331,"symbol":"btcusdt","account-id":${SPOT_ACCOUNT},"client-order-id":"23456","amount":"5.000000000000000000","price":"1.000000000000000000","created-at":${now - 40 * MINUTE},"type":"buy-limit-maker","field-amount":"0.0","field-cash-amount":"0.0","field-fees":"0.0","finished-at":0,"source":"spot-api","state":"submitted","canceled-at":0}`,
      ],
    ]);
    this.fills = [
      // Newest first, as HTX lists them.
      // The fee paid with points instead.
      `{"symbol":"btcusdt","fee-currency":"usdt","source":"spot-web","price":"61000","created-at":${now - 5 * MINUTE},"role":"taker","order-id":345487249132375,"match-id":5015,"trade-id":1086,"filled-amount":"0.0005","filled-fees":"0","filled-points":"0.1","fee-deduct-currency":"hbpoint","fee-deduct-state":"done","id":313288753120941,"type":"sell-market"}`,
      // A maker rebate, which HTX reports as a negative fee.
      `{"symbol":"ethusdt","fee-currency":"usdt","source":"spot-web","price":"3000.5","created-at":${now - 15 * MINUTE},"role":"maker","order-id":345487249132400,"match-id":6001,"trade-id":2001,"filled-amount":"0.1","filled-fees":"-0.0060010","filled-points":"","fee-deduct-currency":"","fee-deduct-state":"done","id":313288753120950,"type":"sell-limit-maker"}`,
      // The fee in the bought asset.
      `{"symbol":"btcusdt","fee-currency":"btc","source":"spot-api","price":"60000.01","created-at":${now - 25 * MINUTE},"role":"taker","order-id":357630527817871,"match-id":5014,"trade-id":1085,"filled-amount":"0.001","filled-fees":"0.000002","filled-points":"0","fee-deduct-currency":"","fee-deduct-state":"done","id":313288753120940,"type":"buy-limit"}`,
    ];
  }

  /** Makes the next request to `path` answer `response` instead. */
  failNext(path: string, response: () => Response) {
    this.#failures.set(path, [...(this.#failures.get(path) ?? []), response]);
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN)
      throw new Error(`Unexpected origin ${url.origin}`);
    const method = init.method ?? "GET";
    if (method !== "GET" || init.body !== undefined) {
      this.refused.push({ method, path: url.pathname });
      return json(
        `{"status":"error","err-code":"method-not-allowed","err-msg":"method not allowed"}`,
        405,
      );
    }
    const signed = url.searchParams.has("Signature");
    this.requests.push({
      path: url.pathname,
      parameters: url.searchParams,
      signed,
    });
    const failure = this.#failures.get(url.pathname)?.shift();
    if (failure) return failure();
    const publicResponse = this.#public(url);
    if (publicResponse) return publicResponse;
    if (!this.#validSignature(url))
      return error(
        "api-signature-not-valid",
        "Signature not valid: Verification failure",
      );
    return this.#private(url);
  };

  #public(url: URL): Response | undefined {
    const symbol = url.searchParams.get("symbol");
    const listed = symbol === "btcusdt" || symbol === "ethusdt";
    switch (url.pathname) {
      case "/v1/common/timestamp":
        return ok(String(this.now()));
      case "/v1/settings/common/market-symbols":
        return json(HTX_SAMPLES.marketSymbols);
      case "/market/tickers":
        return json(HTX_SAMPLES.tickers);
      case "/market/history/kline": {
        if (!listed) return json(HTX_SAMPLES.invalidSymbol);
        const sample = {
          "60min": HTX_SAMPLES.kline60min,
          "1day": HTX_SAMPLES.kline1day,
          "1mon": HTX_SAMPLES.kline1mon,
        }[url.searchParams.get("period") ?? ""];
        return sample
          ? json(sample)
          : error("invalid-parameter", "invalid period");
      }
      case "/market/depth": {
        if (!listed) return json(HTX_SAMPLES.invalidSymbol);
        const depth = url.searchParams.get("depth");
        if (depth && !["5", "10", "20"].includes(depth))
          return error("invalid-parameter", "invalid depth");
        const body = rawNumbers(HTX_SAMPLES.depth20) as {
          tick: { bids: unknown[]; asks: unknown[] };
        };
        // The recorded book has 20 levels a side; HTX sends 150 without depth.
        const levels = Number(depth ?? 150);
        body.tick.bids = body.tick.bids.slice(0, levels);
        body.tick.asks = body.tick.asks.slice(0, levels);
        return json(JSON.stringify(body));
      }
      case "/market/trade":
        return listed
          ? json(HTX_SAMPLES.trade)
          : json(HTX_SAMPLES.invalidSymbol);
    }
    return undefined;
  }

  /**
   * Checks signature version 2 as HTX documents it: the auth parameters are
   * present, the timestamp is within 5 minutes, the parameters arrive in
   * ASCII order, and the signature is the HmacSHA256 of the pre-signed text.
   */
  #validSignature(url: URL) {
    const parameters = url.searchParams;
    if (
      parameters.get("AccessKeyId") !== this.apiKey ||
      parameters.get("SignatureMethod") !== "HmacSHA256" ||
      parameters.get("SignatureVersion") !== "2"
    )
      return false;
    const timestamp = parameters.get("Timestamp") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(timestamp)) return false;
    if (Math.abs(Date.parse(`${timestamp}Z`) - this.now()) > 5 * MINUTE)
      return false;
    const pieces = url.search.slice(1).split("&");
    const signature = pieces.pop() ?? "";
    if (!signature.startsWith("Signature=")) return false;
    const names = pieces.map((piece) => piece.split("=")[0]);
    if (names.some((name, index) => index > 0 && names[index - 1] > name))
      return false;
    const expected = createHmac("sha256", this.apiSecret)
      .update(`GET\napi.huobi.pro\n${url.pathname}\n${pieces.join("&")}`)
      .digest("base64");
    return (
      decodeURIComponent(signature.slice("Signature=".length)) === expected
    );
  }

  #private(url: URL): Response {
    const parameters = url.searchParams;
    const path = url.pathname;
    if (path === "/v1/account/accounts") return ok(this.accounts);
    if (path === `/v1/account/accounts/${SPOT_ACCOUNT}/balance`)
      return ok(
        `{"id":${SPOT_ACCOUNT},"type":"spot","state":"working","list":${JSON.stringify(
          this.balances.map((entry) => ({ ...entry, "seq-num": "477" })),
        )}}`,
      );
    if (path.startsWith("/v1/account/accounts/"))
      return error(
        "account-get-accounts-inexistent-error",
        "account for id does not exist",
      );
    if (path === "/v1/order/openOrders") {
      if (parameters.get("account-id") !== SPOT_ACCOUNT)
        return error("account-account-id-inexistent", "invalid account id");
      const symbol = parameters.get("symbol");
      const size = Number(parameters.get("size") ?? 100);
      return ok(
        `[${this.openOrders
          .filter((order) => !symbol || order.includes(`"symbol":"${symbol}"`))
          .slice(0, size)
          .join(",")}]`,
      );
    }
    if (path === "/v1/order/matchresults") {
      const symbol = parameters.get("symbol");
      if (!symbol) return error("validation-constraints-required", "symbol");
      const size = Number(parameters.get("size") ?? 100);
      return ok(
        `[${this.fills
          .filter((fill) => fill.includes(`"symbol":"${symbol}"`))
          .slice(0, size)
          .join(",")}]`,
      );
    }
    const order = /^\/v1\/order\/orders\/(\d+)(\/matchresults)?$/.exec(path);
    if (order) {
      const [, id, matchResults] = order;
      if (matchResults)
        return ok(
          `[${this.fills.filter((fill) => fill.includes(`"order-id":${id},`)).join(",")}]`,
        );
      const found = this.orders.get(id);
      return found ? ok(found) : error("base-record-invalid", "record invalid");
    }
    if (path === "/v2/user/uid")
      return this.subUser
        ? json(`{"code":1002,"message":"forbidden"}`)
        : json(`{"code":200,"data":${this.uid}}`);
    if (path === "/v2/user/api-key") {
      if (this.subUser) return json(`{"code":1002,"message":"forbidden"}`);
      if (parameters.get("uid") !== this.uid)
        return json(`{"code":2002,"message":"invalid field value in uid"}`);
      const accessKey = parameters.get("accessKey");
      const keys = [
        {
          accessKey: "160bb889-b7XXXXbe-e0XXXXf5-ghxertfvbf",
          permission: "readOnly,trade",
        },
        { accessKey: this.apiKey, permission: this.permission },
      ].filter((key) => !accessKey || key.accessKey === accessKey);
      return json(
        `{"code":200,"message":"success","data":${JSON.stringify(
          keys.map((key) => ({
            ...key,
            status: "normal",
            note: "crypto trading",
            ipAddresses: "",
            validDays: -1,
            createTime: 1615192704000,
            updateTime: 1623030338000,
          })),
        )},"ok":true}`,
      );
    }
    return json(
      `{"status":"error","err-code":"method-not-allowed","err-msg":"path not found"}`,
      405,
    );
  }
}
