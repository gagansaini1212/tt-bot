import { route, type Route } from "../http";
import { depth, klines, tickers } from "./market";
import { snapshot } from "./snapshot";

/**
 * The worker's HTTP endpoints. To add one, write a handler module and list it
 * here. Each call creates fresh caches; `now` is their clock.
 */
export function createRoutes(now: () => number = Date.now): Route[] {
  // The HTTP service exposes reads only. Order commands run locally via CLI.
  return [
    route("GET", "/snapshot", snapshot(now)),
    route("GET", "/market/tickers", tickers(now)),
    route("GET", "/market/klines", klines(now)),
    route("GET", "/market/depth", depth(now)),
  ];
}
