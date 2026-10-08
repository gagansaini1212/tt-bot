import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { DashboardShell } from "@/components/dashboard-shell";
import { themeScript } from "@/lib/theme";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Northstar Trading",
  description: "Binance Spot Testnet account monitoring and trading analysis.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The server renders the default dark theme; the inline script swaps it
    // for the stored preference before first paint, hence the suppressed
    // hydration warning.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <DashboardShell>{children}</DashboardShell>
      </body>
    </html>
  );
}
