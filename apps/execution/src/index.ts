import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import Decimal from "decimal.js";
import {
  BinanceSpotTestnet,
  BinanceTestnetError,
  limitOrderSchema,
  testnetInstrumentSchema,
} from "@crypto-trading/exchanges";
import { authorizeTradeProposal } from "@crypto-trading/domain";

export { authorizeTradeProposal };

async function main() {
  if (
    process.env.LIVE_TRADING_ENABLED &&
    process.env.LIVE_TRADING_ENABLED !== "false"
  ) {
    throw new Error(
      "Live trading cannot start until deployment prerequisites and account eligibility checks are implemented.",
    );
  }
  const provider = process.env.EXCHANGE_PROVIDER ?? "fixture";
  if (!["fixture", "binance-spot-testnet"].includes(provider)) {
    throw new Error(
      "EXCHANGE_PROVIDER must be fixture or binance-spot-testnet.",
    );
  }
  const [command = "serve", ...args] = process.argv.slice(2);
  if (command === "help") {
    console.info(
      "Commands: serve, check, balances, orders, fills, order <instrument> <client-id>, test-order|place-order <instrument> <BUY|SELL> <quantity> <price> <client-id>, cancel <instrument> <client-id>",
    );
    return;
  }
  let privateKey: string | undefined;
  if (
    provider === "binance-spot-testnet" &&
    process.env.BINANCE_TESTNET_PRIVATE_KEY_PATH
  ) {
    try {
      privateKey = await readFile(
        process.env.BINANCE_TESTNET_PRIVATE_KEY_PATH,
        "utf8",
      );
    } catch {
      throw new Error(
        "Could not read BINANCE_TESTNET_PRIVATE_KEY_PATH. Use an absolute path to the local PEM private key.",
      );
    }
  }
  const exchange =
    provider === "binance-spot-testnet" &&
    process.env.BINANCE_TESTNET_API_KEY &&
    (privateKey || process.env.BINANCE_TESTNET_API_SECRET)
      ? new BinanceSpotTestnet({
          apiKey: process.env.BINANCE_TESTNET_API_KEY,
          apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
          privateKey,
        })
      : undefined;

  if (command === "serve") {
    const token = process.env.EXECUTION_API_TOKEN;
    if (!token || token.length < 32)
      throw new Error(
        "Set EXECUTION_API_TOKEN to at least 32 characters, shared with apps/web/.env.local.",
      );
    const port = Number(process.env.EXECUTION_PORT ?? "4001");
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("EXECUTION_PORT must be between 1024 and 65535.");
    let snapshot:
      Awaited<ReturnType<BinanceSpotTestnet["getSnapshot"]>> | undefined;
    let pending: ReturnType<BinanceSpotTestnet["getSnapshot"]> | undefined;
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      const received = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        request.headers.origin ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        response.writeHead(401).end(JSON.stringify({ status: "unauthorized" }));
        return;
      }
      // The HTTP service exposes reads only. Order commands run locally via CLI.
      if (request.method !== "GET" || request.url !== "/snapshot") {
        response.writeHead(404).end(JSON.stringify({ status: "not_found" }));
        return;
      }
      if (!exchange) {
        response.end(
          JSON.stringify({
            status: "not_configured",
            message:
              "Configure Binance Spot Testnet in the execution service to connect your virtual account.",
          }),
        );
        return;
      }
      try {
        if (
          !snapshot ||
          Date.now() - Date.parse(snapshot.capturedAt) > 10_000
        ) {
          pending ??= exchange.getSnapshot().finally(() => {
            pending = undefined;
          });
          snapshot = await pending;
        }
        response.end(JSON.stringify({ status: "connected", snapshot }));
      } catch (error) {
        response.writeHead(503).end(
          JSON.stringify({
            status: "unavailable",
            message: safeError(error),
          }),
        );
      }
    });
    server.listen(port, "127.0.0.1", () =>
      console.info(
        `Execution service on http://127.0.0.1:${port}. Provider: ${provider}.`,
      ),
    );
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  if (!exchange)
    throw new Error(
      "Set EXCHANGE_PROVIDER=binance-spot-testnet, BINANCE_TESTNET_API_KEY, and either BINANCE_TESTNET_PRIVATE_KEY_PATH or BINANCE_TESTNET_API_SECRET in apps/execution/.env.",
    );
  let result: unknown;
  switch (command) {
    case "check": {
      if (args.length) throw new Error("Usage: check");
      const account = await exchange.getAccount();
      result = {
        provider,
        connected: true,
        canTrade: account.canTrade,
        assets: account.balances.length,
      };
      break;
    }
    case "balances":
      result = await exchange.getAccount();
      break;
    case "orders":
      result = (await exchange.getSnapshot()).orders;
      break;
    case "fills":
      result = (await exchange.getSnapshot()).fills;
      break;
    case "order":
    case "cancel": {
      if (args.length !== 2)
        throw new Error("Usage: order|cancel <BTC-USDT|ETH-USDT> <client-id>");
      const instrument = testnetInstrumentSchema.parse(args[0]);
      result =
        command === "order"
          ? await exchange.getOrder(instrument, args[1])
          : await exchange.cancelOrder(instrument, args[1]);
      break;
    }
    case "test-order":
    case "place-order": {
      if (args.length !== 5)
        throw new Error(
          "Usage: test-order|place-order <BTC-USDT|ETH-USDT> <BUY|SELL> <quantity> <price> <ct_client-id>",
        );
      const order = limitOrderSchema.parse({
        instrument: args[0],
        side: args[1],
        quantity: args[2],
        price: args[3],
        clientOrderId: args[4],
      });
      const cap = process.env.TESTNET_MAX_ORDER_NOTIONAL_USDT;
      if (!cap || !/^\d+(\.\d+)?$/.test(cap) || !new Decimal(cap).gt(0))
        throw new Error(
          "Set a positive TESTNET_MAX_ORDER_NOTIONAL_USDT for manual development orders.",
        );
      if (new Decimal(order.quantity).times(order.price).gt(cap))
        throw new Error("Order exceeds TESTNET_MAX_ORDER_NOTIONAL_USDT.");
      // Binance validates current price, quantity, notional and account filters.
      await exchange.testLimitOrder(order);
      if (command === "test-order") {
        result = {
          valid: true,
          submitted: false,
          clientOrderId: order.clientOrderId,
        };
        break;
      }
      // Record intent before sending. Never submit this ID twice, even after restart.
      const directory = resolve(
        process.env.TESTNET_ORDER_JOURNAL_DIR ?? ".testnet-orders",
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const intent = resolve(directory, `${order.clientOrderId}.json`);
      try {
        await writeFile(
          intent,
          JSON.stringify({
            order,
            status: "submission_pending",
            createdAt: new Date().toISOString(),
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        throw new Error(
          "Could not record a new order intent. If this client ID was used already, query it with the order command before taking further action.",
        );
      }
      result = await exchange.placeLimitOrder(order);
      await writeFile(
        intent,
        JSON.stringify({ order, status: "acknowledged", result }),
        { mode: 0o600 },
      );
      break;
    }
    default:
      throw new Error("Unknown execution command. Run pnpm exchange help.");
  }
  console.info(JSON.stringify(result, null, 2));
}

function safeError(error: unknown): string {
  if (error instanceof BinanceTestnetError) return error.message;
  return "Execution service could not complete the request. Check the local configuration.";
}

main().catch((error: unknown) => {
  // Only our controlled messages are safe to print; validation/transport errors may contain inputs.
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : safeError(error),
  );
  process.exitCode = 1;
});
