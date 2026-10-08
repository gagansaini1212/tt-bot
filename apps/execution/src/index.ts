import { createServer, type RequestListener, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";
import {
  BinanceSpotTestnet,
  limitOrderSchema,
  testnetInstrumentSchema,
} from "@crypto-trading/exchanges";
import { authorizeTradeProposal } from "@crypto-trading/domain";
import { createRequestListener, safeError } from "./http";
import { OrderJournal } from "./order-journal";
import { createRoutes } from "./routes";

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
    const handle = createRequestListener({
      token,
      exchange,
      routes: createRoutes(),
    });
    const servers = [await listen(handle, port, "127.0.0.1")];
    // `localhost` usually resolves to [::1] first, so hold it too: no other local
    // process may receive the token there. Skip it only without IPv6 loopback.
    const ipv6 = await listen(handle, port, "::1").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
          return undefined;
        servers[0].close();
        throw error;
      },
    );
    if (ipv6) servers.push(ipv6);
    console.info(
      `Execution service on http://127.0.0.1:${port}${ipv6 ? ` and http://[::1]:${port}` : ""}. Provider: ${provider}.`,
    );
    const shutdown = () =>
      Promise.all(
        servers.map((server) => new Promise((closed) => server.close(closed))),
      ).then(() => process.exit(0));
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
      const journal = new OrderJournal();
      const intent = {
        order,
        status: "submission_pending",
        createdAt: new Date().toISOString(),
      };
      if (!(await journal.reserve(order.clientOrderId, intent)))
        throw new Error(
          "Could not record a new order intent. If this client ID was used already, query it with the order command before taking further action.",
        );
      result = await exchange.placeLimitOrder(order);
      await journal.update(order.clientOrderId, {
        order,
        status: "acknowledged",
        result,
      });
      break;
    }
    default:
      throw new Error("Unknown execution command. Run pnpm exchange help.");
  }
  console.info(JSON.stringify(result, null, 2));
}

function listen(handle: RequestListener, port: number, host: string) {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(handle);
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
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
