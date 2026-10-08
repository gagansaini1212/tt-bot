// Network-free Binance contract fixture, loaded only by execution tests.
import { appendFile } from "node:fs/promises";

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://testnet.binance.vision")
    throw new Error("Unexpected fixture origin");
  const params = init.body
    ? new URLSearchParams(String(init.body))
    : url.searchParams;
  await appendFile(
    process.env.FIXTURE_REQUEST_LOG,
    `${JSON.stringify({ method: init.method, path: url.pathname, clientId: params.get("newClientOrderId") ?? params.get("origClientOrderId") })}\n`,
  );
  if (url.pathname === "/api/v3/time")
    return Response.json({ serverTime: Date.now() });
  if (url.pathname === "/api/v3/account")
    return Response.json({
      canTrade: true,
      balances: [{ asset: "USDT", free: "10000.12345678", locked: "0" }],
    });
  if (url.pathname === "/api/v3/order/test") return Response.json({});
  if (url.pathname === "/api/v3/order") {
    if (
      process.env.FIXTURE_UNKNOWN_OUTCOME === "true" &&
      init.method === "POST"
    )
      return Response.json({ code: -1007, msg: "Timeout" }, { status: 504 });
    return Response.json({
      symbol: "BTCUSDT",
      orderId: 123,
      clientOrderId:
        params.get("newClientOrderId") ?? params.get("origClientOrderId"),
      price: "60000",
      origQty: "0.001",
      executedQty: "0",
      cummulativeQuoteQty: "0",
      status: init.method === "DELETE" ? "CANCELED" : "NEW",
      type: "LIMIT",
      side: "BUY",
    });
  }
  if (url.pathname === "/api/v3/ticker/24hr")
    return Response.json([
      {
        symbol: "BTCUSDT",
        priceChange: "-10.00",
        priceChangePercent: "-0.017",
        lastPrice: "60000.01",
        openPrice: "60010.01",
        highPrice: "60100.00",
        lowPrice: "59900.00",
        volume: "12.5",
        quoteVolume: "750000.12",
        openTime: Date.now() - 86_400_000,
        closeTime: Date.now(),
      },
    ]);
  if (
    url.pathname === "/api/v3/openOrders" ||
    url.pathname === "/api/v3/openOrderList" ||
    url.pathname === "/api/v3/myTrades"
  )
    return Response.json([]);
  throw new Error("Unexpected fixture endpoint");
};
