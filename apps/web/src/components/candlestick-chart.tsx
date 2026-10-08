"use client";

import dynamic from "next/dynamic";

// The chart library draws on a canvas and needs the browser, so it loads on
// the client only. The server renders a placeholder the chart's size: the
// readout (three lines on phones, two wider) and the canvas.
export const CandlestickChart = dynamic(
  () =>
    import("./candlestick-canvas").then((module) => module.CandlestickCanvas),
  {
    ssr: false,
    loading: () => (
      <div aria-hidden className="h-[21.5rem] sm:h-[26.5rem] xl:h-[32.5rem]" />
    ),
  },
);
