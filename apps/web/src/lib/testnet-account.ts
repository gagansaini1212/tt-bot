import "server-only";
import {
  testnetSnapshotSchema,
  type TestnetSnapshot,
} from "@crypto-trading/exchanges";

export type TestnetAccountState =
  | { status: "connected"; snapshot: TestnetSnapshot }
  | { status: "not_configured" | "unavailable"; message: string };

// The web app sends the worker's bearer token to this URL, so it must stay on this machine.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseWorkerUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return undefined;
  return url;
}

export async function getTestnetAccount(): Promise<TestnetAccountState> {
  const token = process.env.EXECUTION_API_TOKEN;
  if (!token)
    return {
      status: "not_configured",
      message:
        "Set up Binance Spot Testnet to view virtual balances, orders, and fills here. Follow the testnet setup in README.md.",
    };
  const url = parseWorkerUrl(
    process.env.EXECUTION_API_URL ?? "http://127.0.0.1:4001",
  );
  if (!url)
    return {
      status: "unavailable",
      message:
        "EXECUTION_API_URL must point to the execution worker on this machine, such as http://127.0.0.1:4001. Use 127.0.0.1, localhost, or [::1] as the host.",
    };
  try {
    const response = await fetch(new URL("/snapshot", url), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return {
        status: "unavailable",
        message:
          "The testnet account is unavailable. Check the execution worker and its credentials, then refresh.",
      };
    const data = await response.json();
    if (data.status === "not_configured")
      return {
        status: "not_configured",
        message:
          "Configure the Binance testnet provider and credentials in the execution worker, then restart it.",
      };
    if (data.status !== "connected")
      throw new Error("Unexpected worker response");
    const snapshot = testnetSnapshotSchema.parse(data.snapshot);
    const age = Date.now() - Date.parse(snapshot.capturedAt);
    if (age > 30_000 || age < -5_000) throw new Error("Stale snapshot");
    return { status: "connected", snapshot };
  } catch {
    return {
      status: "unavailable",
      message:
        "The testnet account is unavailable. Start the execution worker and refresh to reconnect.",
    };
  }
}
