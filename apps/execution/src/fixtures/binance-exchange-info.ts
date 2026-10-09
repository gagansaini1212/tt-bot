/**
 * Binance's exchangeInfo for `bases` against USDT, as the catalogue reads
 * it, with the filters of the testnet's BTCUSDT.
 */
export function binanceExchangeInfo(bases: readonly string[] = ["BTC", "ETH"]) {
  return {
    symbols: bases.map((base) => ({
      symbol: `${base}USDT`,
      status: "TRADING",
      baseAsset: base,
      quoteAsset: "USDT",
      orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS"],
      ocoAllowed: true,
      otoAllowed: true,
      opoAllowed: true,
      filters: [
        {
          filterType: "PRICE_FILTER",
          minPrice: "0.01000000",
          maxPrice: "1000000.00000000",
          tickSize: "0.01000000",
        },
        {
          filterType: "LOT_SIZE",
          minQty: "0.00001000",
          maxQty: "9000.00000000",
          stepSize: "0.00001000",
        },
        {
          filterType: "NOTIONAL",
          minNotional: "5.00000000",
          maxNotional: "9000000.00000000",
        },
        { filterType: "MAX_NUM_ALGO_ORDERS", maxNumAlgoOrders: 5 },
      ],
    })),
  };
}
