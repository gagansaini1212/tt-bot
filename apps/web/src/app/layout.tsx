import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { DashboardShell } from "@/components/dashboard-shell";
import { getCurrentCustomer } from "@/lib/current-customer";
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
  title: {
    default: "Crypto Trading Agent",
    template: "%s · Crypto Trading Agent",
  },
  description: "Binance Spot Testnet account monitoring and trading analysis.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The proxy sends signed-out visitors to /sign-in, which has no shell.
  const customer = await getCurrentCustomer();
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
        {customer ? (
          <DashboardShell
            customer={{ name: customer.name, email: customer.email }}
          >
            {children}
          </DashboardShell>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
