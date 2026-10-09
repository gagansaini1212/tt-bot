import { createServer, type RequestListener, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";
import {
  createDatabase,
  DEV_CUSTOMER_ID,
  type Database,
} from "@crypto-trading/database";
import {
  binanceSpotTestnetVenue,
  canTrade,
  credentialsFromKeys,
  ExchangeError,
  htxVenue,
  limitOrderSchema,
  VenueRegistry,
  type ExchangeOrder,
  type SigningCredentials,
} from "@crypto-trading/exchanges";
import {
  authorizeTradeProposal,
  utcDayStart,
  instrumentSchema,
} from "@crypto-trading/domain";
import {
  accountLister,
  accountResolver,
  accountVenue,
  TESTNET_EXCHANGE_ACCOUNT_ID,
} from "./accounts";
import { ExchangeAccountStore } from "./exchange-accounts";
import {
  catalogueMarkets,
  PostgresReportingDirectory,
} from "./reporting-directory";
import {
  connector,
  ExchangeCredentialStore,
  privateKeyType,
  savedOrEnvironmentExchanges,
} from "./exchange-credentials";
import {
  EveDecisionSource,
  parseEveHost,
  RecordedDecisionSource,
  type DecisionSource,
} from "./ai-decisions";
import { createRequestListener, safeError } from "./http";
import { ExecutionLoop } from "./execution-loop";
import { assertNoJournal, importJournal } from "./legacy-journal";
import {
  markNotificationsRead,
  notificationHistory,
  NotificationWebhooks,
} from "./notification-webhooks";
import { PostgresOrderIntents, type Settlement } from "./order-intents";
import {
  manualOrderRisk,
  PostgresRiskLimits,
  withinPlatformMaximums,
} from "./risk-limits";
import { createWorker } from "./routes";
import { accountQueues } from "./manual-orders";
import { SecretBox } from "./secret-box";
import { StrategyRunner } from "./strategy-runner";
import { PostgresTradeProposals } from "./trade-proposals";

export { authorizeTradeProposal };

// Order intents and exchange accounts are in PostgreSQL.
let database: Database | undefined;
function openDatabase() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL in .env to the execution worker's database role. See .env.example and docs/database.md.",
    );
  database ??= createDatabase(process.env.DATABASE_URL);
  return database;
}

/** CLI commands act for the dev customer, who owns the testnet account. */
async function cliScope() {
  const scope = await accountResolver(openDatabase())(
    DEV_CUSTOMER_ID,
    TESTNET_EXCHANGE_ACCOUNT_ID,
  );
  if (!scope)
    throw new Error(
      "The dev customer's testnet exchange account is missing. Run pnpm db:seed.",
    );
  return scope;
}

async function main() {
  if (
    process.env.LIVE_TRADING_ENABLED &&
    process.env.LIVE_TRADING_ENABLED !== "false"
  ) {
    throw new Error(
      "Live trading cannot start until deployment prerequisites and account eligibility checks are implemented.",
    );
  }
  if (process.env.EXCHANGE_PROVIDER)
    console.warn(
      "EXCHANGE_PROVIDER is no longer read: the worker serves every exchange account on the venues it connects to. Remove it from apps/execution/.env.",
    );
  const [command = "serve", ...args] = process.argv.slice(2);
  if (command === "help") {
    console.info(
      "Commands: serve, check, balances, orders, fills, order <instrument> <client-id>, test-order|place-order <instrument> <BUY|SELL> <quantity> <price> <client-id>, cancel <instrument> <client-id>, import-journal",
    );
    return;
  }
  let privateKey: string | undefined;
  if (process.env.BINANCE_TESTNET_PRIVATE_KEY_PATH) {
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
  // The venues the worker connects to, each with its own market catalogue,
  // limits and clock, shared by every account on it and by no other venue.
  // HTX is read only: its clients cannot trade (ADR 0009).
  const registry = new VenueRegistry([binanceSpotTestnetVenue(), htxVenue()]);
  // The worker's own keys, from its .env file. They serve the dev customer's
  // testnet account until keys are saved for it in Settings. Checked now, so
  // keys the venue cannot use stop the worker before it starts.
  let environment: SigningCredentials | undefined;
  if (
    process.env.BINANCE_TESTNET_API_KEY &&
    (privateKey || process.env.BINANCE_TESTNET_API_SECRET)
  ) {
    environment = credentialsFromKeys({
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      apiSecret: privateKey
        ? undefined
        : process.env.BINANCE_TESTNET_API_SECRET,
      privateKey,
    });
    registry.connect("binance-spot-testnet", environment);
  }
  // Throws now if the master key is set but malformed.
  const box = SecretBox.fromEnvironment(process.env);
  const exchangeSource = (database: Database) => {
    const accounts = new ExchangeAccountStore(database);
    return savedOrEnvironmentExchanges({
      store: new ExchangeCredentialStore(database, box),
      registry,
      venueOf: accountVenue(database),
      environment,
      // Each account records what its venue's adapter supports whenever the
      // worker builds its client.
      connected: (account, venue) =>
        accounts.refreshFeatures(account, venue.capabilities),
    });
  };
  // Builds an adapter for new keys, so they can be checked before they are
  // saved: the venue's own, from the registry.
  const connect = connector(registry);
  if (process.env.TESTNET_MAX_ORDER_NOTIONAL_USDT)
    console.warn(
      "TESTNET_MAX_ORDER_NOTIONAL_USDT is no longer read. Set the per-order cap in Settings → Risk limits, then remove it from apps/execution/.env.",
    );

  if (command === "serve") {
    const token = process.env.EXECUTION_API_TOKEN;
    if (!token || token.length < 32)
      throw new Error(
        "Set EXECUTION_API_TOKEN to at least 32 characters, shared with apps/web/.env.local.",
      );
    // Optional: without it, the assistant cannot record its decisions.
    const assistantToken = process.env.EXECUTION_ASSISTANT_TOKEN || undefined;
    if (
      assistantToken !== undefined &&
      (assistantToken.length < 32 || assistantToken === token)
    )
      throw new Error(
        "Set EXECUTION_ASSISTANT_TOKEN to at least 32 characters, different from EXECUTION_API_TOKEN, or leave it empty.",
      );
    const port = Number(process.env.EXECUTION_PORT ?? "4001");
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("EXECUTION_PORT must be between 1024 and 65535.");
    const db = openDatabase();
    await assertNoJournal(process.env);
    const intents = new PostgresOrderIntents(db);
    const accounts = accountResolver(db);
    const listAccounts = accountLister(db);
    const exchanges = exchangeSource(db);
    const risk = new PostgresRiskLimits(db);
    const webhooks = new NotificationWebhooks({ database: db, box });
    const proposals = new PostgresTradeProposals(db);
    // Each account's dashboard placements and strategies' entries go out
    // one at a time.
    const exclusive = accountQueues();
    let accountChanged: (() => void) | undefined;
    const strategies = new StrategyRunner({
      database: db,
      proposals,
      intents,
      decisions: decisionSource(process.env),
      onChange: () => accountChanged?.(),
      exclusive,
    });
    let loop: ExecutionLoop | undefined;
    const exchangeAccounts = new ExchangeAccountStore(db);
    const worker = createWorker({
      intents,
      proposals,
      strategies,
      // The customer's exchange accounts, for totals across them and the
      // assistant's proposals, each read with its own venue's markets.
      directory: new PostgresReportingDirectory(db, exchangeAccounts),
      portfolio: {
        markets: catalogueMarkets(
          new Map(
            registry.venues.map((venue) => [
              venue,
              registry.get(venue)!.market.markets,
            ]),
          ),
        ),
        served: listAccounts,
      },
      exclusive,
      listAccounts,
      risk,
      reader: { state: (scope) => loop!.state(scope) },
      exchangeAccounts: {
        accounts: exchangeAccounts,
        keys: new ExchangeCredentialStore(db, box),
        exchanges,
        connect,
        environmentKeys:
          environment && process.env.BINANCE_TESTNET_API_KEY
            ? {
                keyType: privateKey ? privateKeyType(privateKey) : "hmac",
                apiKeyLast4: environment.apiKey.slice(-4),
              }
            : undefined,
      },
      settings: {
        risk,
        webhooks,
        notifications: {
          list: (customerId) => notificationHistory(db, customerId),
          markRead: (customerId) => markNotificationsRead(db, customerId),
        },
      },
    });
    accountChanged = worker.accountChanged;
    // Watches every exchange account's orders, independently of any
    // request or AI call (ADR 0002), each with its own venue's client for
    // its own keys: an account without keys the worker can use is skipped.
    // It runs their strategies, monitors read-only accounts, and delivers
    // alerts to webhooks.
    loop = new ExecutionLoop({
      database: db,
      clients: async (scope) => {
        const lookup = await exchanges.forAccount(scope);
        if ("problem" in lookup) return undefined;
        const { exchange } = lookup;
        return canTrade(exchange)
          ? { exchange, desk: worker.deskFor(exchange, scope) }
          : { exchange, readOnly: true };
      },
      accounts: listAccounts,
      intents,
      webhooks,
      strategies,
      onChange: worker.accountChanged,
    });
    const handle = createRequestListener({
      token,
      assistantToken,
      exchanges,
      accounts,
      listAccounts,
      routes: worker.routes,
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
    loop.start();
    console.info(
      `Execution service on http://127.0.0.1:${port}${ipv6 ? ` and http://[::1]:${port}` : ""}. Venues: ${registry.venues.join(", ")}. Execution loop running.`,
    );
    console.info(strategies.aiSource.description);
    if (!box)
      console.info(
        "CREDENTIALS_MASTER_KEY is not set, so keys and webhooks cannot be saved in Settings.",
      );
    const shutdown = () =>
      Promise.all([
        ...servers.map(
          (server) => new Promise((closed) => server.close(closed)),
        ),
        loop?.stop(),
      ])
        .then(() => db.end({ timeout: 5 }))
        .then(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  if (command === "import-journal") {
    if (args.length) throw new Error("Usage: import-journal");
    const { directory, found, imported } = await importJournal(
      process.env,
      new PostgresOrderIntents(openDatabase()),
      await cliScope(),
    );
    console.info(
      found
        ? `Imported ${imported} of the ${found} order intents in ${directory}; the others were already in the database. Check them, then delete that directory.`
        : `${directory} holds no order intents.`,
    );
    await database?.end();
    return;
  }
  const setup =
    "Save keys in Settings, or set BINANCE_TESTNET_API_KEY and either BINANCE_TESTNET_PRIVATE_KEY_PATH or BINANCE_TESTNET_API_SECRET in apps/execution/.env.";
  // Commands act for the dev customer's testnet account, with the keys the
  // dashboard uses.
  const scope = await cliScope();
  const lookup = await exchangeSource(openDatabase()).forAccount(scope);
  if ("problem" in lookup)
    throw new Error(
      lookup.problem === "credentials"
        ? "The keys saved in Settings cannot be opened. Set CREDENTIALS_MASTER_KEY to the key that saved them, or save the keys again."
        : setup,
    );
  const { exchange } = lookup;
  if (!canTrade(exchange))
    throw new Error("The dev account's venue is read only here.");
  let result: unknown;
  switch (command) {
    case "check": {
      if (args.length) throw new Error("Usage: check");
      const account = await exchange.getAccount();
      result = {
        venue: exchange.venue,
        keys: lookup.source,
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
    case "fills": {
      const instruments = await new PostgresRiskLimits(
        openDatabase(),
      ).allowedInstruments(scope);
      const snapshot = await exchange.getSnapshot(instruments);
      result = command === "orders" ? snapshot.orders : snapshot.fills;
      break;
    }
    case "order":
    case "cancel": {
      if (args.length !== 2)
        throw new Error(
          "Usage: order|cancel <BASE-QUOTE, such as BTC-USDT> <client-id>",
        );
      const instrument = instrumentSchema.parse(args[0]);
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
          "Usage: test-order|place-order <BASE-QUOTE, such as BTC-USDT> <BUY|SELL> <quantity> <price> <ct_client-id>",
        );
      const order = limitOrderSchema.parse({
        instrument: args[0],
        side: args[1],
        quantity: args[2],
        price: args[3],
        clientOrderId: args[4],
      });
      // The customer's current limits, read before every order.
      const risk = new PostgresRiskLimits(openDatabase());
      const allowed = await risk.allowedInstruments(scope);
      if (!allowed.includes(order.instrument))
        throw new Error(
          `${order.instrument} is not among this exchange account's allowed instruments: ${allowed.join(", ") || "none"}.`,
        );
      const limits = await risk.current(scope);
      if (!limits)
        throw new Error(
          "Set your risk limits in Settings → Risk limits before placing manual orders.",
        );
      const { maxOrderNotional, maxDailyRisk } = withinPlatformMaximums(limits);
      if (new Decimal(order.quantity).times(order.price).gt(maxOrderNotional))
        throw new Error(
          `Order exceeds the ${maxOrderNotional} USDT per-order cap set in Settings.`,
        );
      // A sell adds no risk, so it is never refused for it.
      const orderRisk = manualOrderRisk({ kind: "limit_order", order });
      const dayRisk = orderRisk.isZero()
        ? orderRisk
        : orderRisk.plus(
            await risk.dailyRiskUsed(scope, utcDayStart(new Date())),
          );
      if (dayRisk.gt(maxDailyRisk))
        throw new Error(
          `A CLI buy has no stop loss, so all of it counts against the daily risk limit: today's manual orders would risk ${dayRisk.toFixed()} USDT, over the ${maxDailyRisk} USDT set in Settings.`,
        );
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
      await assertNoJournal(process.env);
      const intents = new PostgresOrderIntents(openDatabase());
      const id = order.clientOrderId;
      if (!(await intents.record(scope, { kind: "limit_order", order }, "cli")))
        throw new Error(
          "Could not record a new order intent. If this client ID was used already, query it with the order command before taking further action.",
        );
      // The intent already blocks the ID, so a failed write only leaves it
      // due for reconciliation.
      const settle = (settlement: Settlement) =>
        intents
          .settle(scope, id, settlement)
          .catch(() =>
            console.error(`Could not record Binance's answer for ${id}.`),
          );
      let placed: ExchangeOrder;
      try {
        placed = await exchange.placeLimitOrder(order);
      } catch (error) {
        const refused =
          error instanceof ExchangeError && error.kind !== "unknown_outcome";
        await settle(
          refused
            ? { status: "rejected", reason: error.message }
            : { status: "unknown" },
        );
        throw error;
      }
      await settle({ status: "acknowledged", orders: [placed] });
      result = placed;
      break;
    }
    default:
      throw new Error("Unknown execution command. Run pnpm exchange help.");
  }
  console.info(JSON.stringify(result, null, 2));
  await database?.end();
}

/**
 * Where AI-managed strategies' decisions come from: the eve assistant at
 * STRATEGY_AI_EVE_URL once a model is configured for it, or else a recorded
 * fixture, labelled as one on every decision.
 */
function decisionSource(env: NodeJS.ProcessEnv): DecisionSource {
  const url = env.STRATEGY_AI_EVE_URL?.trim();
  if (!url) return new RecordedDecisionSource();
  const host = parseEveHost(url);
  if (!host)
    throw new Error(
      "STRATEGY_AI_EVE_URL must point to the eve assistant on this machine, such as http://127.0.0.1:2000. Leave it empty to replay the recorded fixture.",
    );
  return new EveDecisionSource({ host });
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

main().catch(async (error: unknown) => {
  // Only our controlled messages are safe to print; validation/transport errors may contain inputs.
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : safeError(error),
  );
  process.exitCode = 1;
  await database?.end();
});
