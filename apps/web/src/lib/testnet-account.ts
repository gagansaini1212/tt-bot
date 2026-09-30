import "server-only";
import {
  testnetSnapshotSchema,
  type TestnetSnapshot,
} from "@crypto-trading/exchanges";

export type TestnetAccountState =
  | { status: "connected"; snapshot: TestnetSnapshot }
  | { status: "not_configured" | "unavailable"; message: string };

export async function getTestnetAccount(): Promise<TestnetAccountState> {
  const token = process.env.EXECUTION_API_TOKEN;
  if (!token)
    return {
      status: "not_configured",
      message:
        "Set up Binance Spot Testnet to view virtual balances, orders, and fills here. Follow the testnet setup in README.md.",
    };
  const origin = process.env.EXECUTION_API_URL ?? "http://127.0.0.1:4001";
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return {
        status: "unavailable",
        message: "The execution service URL must point to the local worker.",
      };
    }
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
