import type { IncomingMessage, RequestListener } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  BinanceTestnetError,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import type { AccountResolver, AccountScope } from "./accounts";
import type { ExchangeSource } from "./exchange-credentials";

type Method = "GET" | "POST" | "DELETE";

/**
 * Who may call a route. The web server holds the worker's main token. The
 * analysis assistant holds its own, which reaches only the routes marked for
 * it: it records decisions and can never place an order.
 */
export type Caller = "web" | "assistant";

/**
 * What an endpoint accepts and does. The query, and a JSON body if `body` is
 * set, are validated before `handle` runs; invalid input returns 400.
 * `handle` returns the 200 response body, such as `{ status: "connected", ... }`.
 *
 * The request acts for the customer the caller names in the X-Customer-Id
 * header, and runs only if that customer owns the exchange account the
 * worker trades on. `account` is that account, and `exchange` the Binance
 * client for its keys: the ones saved in Settings, or else the worker's.
 * Only the web server may call it, unless `caller` says the assistant does
 * instead.
 */
export interface Handler<Query, Body> {
  caller?: Caller;
  query: z.ZodType<Query>;
  body?: z.ZodType<Body>;
  handle(context: {
    exchange: BinanceSpotTestnet;
    query: Query;
    body: Body;
    account: AccountScope;
  }): Promise<object>;
}

/**
 * A customer's endpoint for their exchange account that does not call
 * Binance, such as their keys or risk limits. It runs like a `Handler`, but
 * also without exchange keys.
 */
export interface AccountHandler<Query, Body> {
  needs: "account";
  caller?: Caller;
  query: z.ZodType<Query>;
  body?: z.ZodType<Body>;
  handle(context: {
    query: Query;
    body: Body;
    account: AccountScope;
  }): Promise<object>;
}

/**
 * A customer's endpoint that needs no exchange account, such as their
 * notifications. It runs for the customer named in X-Customer-Id.
 */
export interface CustomerHandler<Query, Body> {
  needs: "customer";
  query: z.ZodType<Query>;
  body?: z.ZodType<Body>;
  handle(context: {
    query: Query;
    body: Body;
    customerId: string;
  }): Promise<object>;
}

/** An endpoint serving public market data to the web server. */
export interface PublicHandler<Query> {
  public: true;
  query: z.ZodType<Query>;
  handle(context: {
    exchange: BinanceSpotTestnet;
    query: Query;
  }): Promise<object>;
}

/** Infers a handler's query and body types. */
export function handler<Query, Body = undefined>(
  definition: Handler<Query, Body>,
) {
  return definition;
}

/** Infers an account handler's query and body types. */
export function accountHandler<Query, Body = undefined>(
  definition: Omit<AccountHandler<Query, Body>, "needs">,
): AccountHandler<Query, Body> {
  return { ...definition, needs: "account" };
}

/** Infers a customer handler's query and body types. */
export function customerHandler<Query, Body = undefined>(
  definition: Omit<CustomerHandler<Query, Body>, "needs">,
): CustomerHandler<Query, Body> {
  return { ...definition, needs: "customer" };
}

/** Infers a public handler's query type. */
export function publicHandler<Query>(
  definition: Omit<PublicHandler<Query>, "public">,
): PublicHandler<Query> {
  return { ...definition, public: true };
}

export interface Route {
  method: Method;
  path: `/${string}`;
  caller: Caller;
  handle(input: {
    exchanges: ExchangeSource;
    accounts: AccountResolver;
    search: string;
    request: IncomingMessage;
  }): Promise<object>;
}

/** A non-200 response thrown from a handler. Its body is sent as is, so keep it safe. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: { status: string; message: string },
  ) {
    super(body.message);
  }
}

const MAX_BODY_BYTES = 16 * 1024;
const customerIdSchema = z.uuid();

/**
 * Why the worker did nothing. The web app treats each as "not sent".
 * - exchange: no Binance credentials.
 * - credentials: saved credentials the worker cannot open.
 * - database: PostgreSQL is unreachable or misconfigured.
 * - exchange_account: the customer does not own the account the worker
 *   trades on, or it has not been seeded.
 */
function notConfigured(
  reason: "exchange" | "credentials" | "database" | "exchange_account",
) {
  const messages = {
    exchange:
      "Configure Binance Spot Testnet in the execution service to connect your virtual account.",
    credentials:
      "The saved exchange keys cannot be opened. Check the execution worker's CREDENTIALS_MASTER_KEY, or save the keys again in Settings.",
    database:
      "The execution service cannot use its database. Check its output, then retry.",
    exchange_account:
      "This customer has no Binance Spot Testnet exchange account on the execution service.",
  };
  return { status: "not_configured", reason, message: messages[reason] };
}

export function route<Query, Body>(
  method: Method,
  path: `/${string}`,
  definition:
    | Handler<Query, Body>
    | AccountHandler<Query, Body>
    | CustomerHandler<Query, Body>
    | PublicHandler<Query>,
): Route {
  return {
    method,
    path,
    caller: ("caller" in definition && definition.caller) || "web",
    async handle({ exchanges, accounts, search, request }) {
      const query = parse(
        definition.query,
        searchParameters(search),
        "query parameters",
      );
      if ("public" in definition) {
        const exchange = exchanges.market();
        if (!exchange) return notConfigured("exchange");
        return definition.handle({ exchange, query });
      }
      const body = definition.body
        ? parse(definition.body, await readJson(request), "request body")
        : (undefined as Body);
      const customerId = parse(
        customerIdSchema,
        request.headers["x-customer-id"],
        "customer",
      );
      if ("needs" in definition && definition.needs === "customer")
        return definition.handle({ query, body, customerId });
      let account: AccountScope | undefined;
      try {
        account = await accounts(customerId);
      } catch {
        return notConfigured("database");
      }
      if (!account) return notConfigured("exchange_account");
      if ("needs" in definition)
        return definition.handle({ query, body, account });
      let lookup: Awaited<ReturnType<ExchangeSource["forAccount"]>>;
      try {
        lookup = await exchanges.forAccount(account);
      } catch {
        return notConfigured("database");
      }
      if ("problem" in lookup) return notConfigured(lookup.problem);
      return definition.handle({
        exchange: lookup.exchange,
        query,
        body,
        account,
      });
    },
  };
}

/**
 * Serves `routes` to callers holding a bearer token: `token`, the web
 * server's, or `assistantToken`, the analysis assistant's, each for its own
 * routes. Requests carrying an Origin header come from a browser and are
 * refused. Only those two hold a token, so the worker trusts the customer
 * they name in X-Customer-Id.
 */
export function createRequestListener({
  token,
  assistantToken,
  exchanges,
  accounts,
  routes,
}: {
  token: string;
  assistantToken?: string;
  exchanges: ExchangeSource;
  accounts: AccountResolver;
  routes: readonly Route[];
}): RequestListener {
  const tokens = new Map<Caller, Buffer>([["web", bearer(token)]]);
  if (assistantToken) tokens.set("assistant", bearer(assistantToken));
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, body: object) => {
      response.writeHead(status).end(JSON.stringify(body));
    };
    const received = Buffer.from(request.headers.authorization ?? "");
    const caller = [...tokens].find(
      ([, expected]) =>
        received.length === expected.length &&
        timingSafeEqual(received, expected),
    )?.[0];
    if (request.headers.origin || !caller)
      return send(401, { status: "unauthorized" });
    // Paths match exactly, without normalization or absolute-form URLs.
    const target = request.url ?? "";
    const queryStart = target.indexOf("?");
    const path = queryStart === -1 ? target : target.slice(0, queryStart);
    const matches = routes.filter((route) => route.path === path);
    if (!matches.length) return send(404, { status: "not_found" });
    const route = matches.find((route) => route.method === request.method);
    if (!route) {
      response.setHeader(
        "Allow",
        matches.map((route) => route.method).join(", "),
      );
      return send(405, { status: "method_not_allowed" });
    }
    if (route.caller !== caller) return send(403, { status: "forbidden" });
    try {
      send(
        200,
        await route.handle({
          exchanges,
          accounts,
          search: queryStart === -1 ? "" : target.slice(queryStart + 1),
          request,
        }),
      );
    } catch (error) {
      if (error instanceof RequestError) return send(error.status, error.body);
      send(503, { status: "unavailable", message: safeError(error) });
    }
  };
}

function bearer(token: string) {
  return Buffer.from(`Bearer ${token}`);
}

export function safeError(error: unknown): string {
  if (error instanceof BinanceTestnetError) return error.message;
  return "Execution service could not complete the request. Check the local configuration.";
}

function invalid(part: string) {
  return new RequestError(400, {
    status: "invalid_request",
    message: `Check the ${part}.`,
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, part: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(part);
  return parsed.data;
}

function searchParameters(search: string) {
  const entries = [...new URLSearchParams(search)];
  const parameters = Object.fromEntries(entries);
  // A repeated parameter is ambiguous.
  if (Object.keys(parameters).length !== entries.length)
    throw invalid("query parameters");
  return parameters;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"]?.split(";")[0].trim();
  if (type?.toLowerCase() !== "application/json") throw invalid("request body");
  // Node ends the body at Content-Length, so checking the header bounds the read.
  const length = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES)
    throw new RequestError(413, {
      status: "invalid_request",
      message: `Send a JSON body of at most ${MAX_BODY_BYTES} bytes with a Content-Length.`,
    });
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("request body");
  }
}
