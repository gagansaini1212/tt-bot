import type { IncomingMessage, RequestListener } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import {
  BinanceTestnetError,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";

type Method = "GET" | "POST" | "DELETE";

/**
 * What an endpoint accepts and does. The query, and a JSON body if `body` is
 * set, are validated before `handle` runs; invalid input returns 400.
 * `handle` returns the 200 response body, such as `{ status: "connected", ... }`.
 */
export interface Handler<Query, Body> {
  query: z.ZodType<Query>;
  body?: z.ZodType<Body>;
  handle(context: {
    exchange: BinanceSpotTestnet;
    query: Query;
    body: Body;
  }): Promise<object>;
}

/** Infers a handler's query and body types. */
export function handler<Query, Body = undefined>(
  definition: Handler<Query, Body>,
) {
  return definition;
}

export interface Route {
  method: Method;
  path: `/${string}`;
  handle(input: {
    exchange: BinanceSpotTestnet | undefined;
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

export function route<Query, Body>(
  method: Method,
  path: `/${string}`,
  { query, body, handle }: Handler<Query, Body>,
): Route {
  return {
    method,
    path,
    async handle({ exchange, search, request }) {
      const context = {
        query: parse(query, searchParameters(search), "query parameters"),
        body: body
          ? parse(body, await readJson(request), "request body")
          : (undefined as Body),
      };
      if (!exchange)
        return {
          status: "not_configured",
          message:
            "Configure Binance Spot Testnet in the execution service to connect your virtual account.",
        };
      return handle({ exchange, ...context });
    },
  };
}

/**
 * Serves `routes` to callers holding the bearer token. Requests carrying an
 * Origin header come from a browser and are refused.
 */
export function createRequestListener({
  token,
  exchange,
  routes,
}: {
  token: string;
  exchange: BinanceSpotTestnet | undefined;
  routes: readonly Route[];
}): RequestListener {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, body: object) => {
      response.writeHead(status).end(JSON.stringify(body));
    };
    const received = Buffer.from(request.headers.authorization ?? "");
    if (
      request.headers.origin ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
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
    try {
      send(
        200,
        await route.handle({
          exchange,
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
