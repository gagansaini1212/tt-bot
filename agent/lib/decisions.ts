/** The model the analysis assistant runs on. Every decision records it. */
export const ASSISTANT_MODEL = "openai/gpt-6-luna";

/**
 * The version of the assistant's instructions and decision tools, recorded
 * with every decision. Change it whenever instructions.md or a decision tool
 * changes what the assistant is told or asked to give.
 */
export const PROMPT_VERSION = "assistant-2026-10-09.1";

// The assistant sends its worker token here, so it must stay on this machine.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_WORKER_URL = "http://127.0.0.1:4001";
const TIMEOUT_MS = 10_000;

export type RecordedDecision =
  | {
      recorded: true;
      decisionId: string;
      proposalId: string | null;
    }
  | { recorded: false; reason: string };

type DecisionBody =
  // A proposal names the one exchange account it trades on.
  | { kind: "trade_proposal"; exchangeAccountId: string; proposal: object }
  | { kind: "no_trade"; instrument: string | null };

/**
 * Asks the execution worker to record one AI decision for `customerId`. The
 * assistant has no database or exchange access: its own worker token,
 * EXECUTION_ASSISTANT_TOKEN, records decisions and reaches nothing else.
 * `call` identifies the tool call, so a replayed call records nothing twice.
 * Throws if the worker refuses the decision itself, so the model can fix it.
 */
export async function recordDecision(
  customerId: string,
  call: { sessionId: string; callId: string },
  decision: DecisionBody & { sourceSnapshotId: string; rationale: string },
): Promise<RecordedDecision> {
  const token = process.env.EXECUTION_ASSISTANT_TOKEN;
  if (!token)
    return {
      recorded: false,
      reason:
        "EXECUTION_ASSISTANT_TOKEN is not set for the assistant, so decisions cannot be saved.",
    };
  const url = URL.parse(process.env.EXECUTION_API_URL || DEFAULT_WORKER_URL);
  if (!url || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))
    return {
      recorded: false,
      reason:
        "EXECUTION_API_URL must point to the execution worker on this machine.",
    };
  url.pathname = "/decisions";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Customer-Id": customerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...decision,
        model: ASSISTANT_MODEL,
        promptVersion: PROMPT_VERSION,
        idempotencyKey: `${call.sessionId}:${call.callId}`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return {
      recorded: false,
      reason: "The execution worker is unavailable.",
    };
  }
  const body = (await response.json().catch(() => null)) as {
    status?: string;
    message?: string;
    decision?: { id?: string; proposal?: { id?: string } | null };
  } | null;
  if (response.status === 400)
    throw new Error(
      `The decision was not saved. ${body?.message ?? "Check its fields."}`,
    );
  if (
    !response.ok ||
    body?.status !== "connected" ||
    typeof body.decision?.id !== "string"
  )
    return {
      recorded: false,
      reason:
        body?.message ?? "The execution worker could not save the decision.",
    };
  return {
    recorded: true,
    decisionId: body.decision.id,
    proposalId: body.decision.proposal?.id ?? null,
  };
}
