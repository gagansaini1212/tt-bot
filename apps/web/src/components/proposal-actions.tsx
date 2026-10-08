"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { CheckCircle2, LoaderCircle, X } from "lucide-react";
import type {
  ProposalStatus,
  ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";
import type { ManualOrderOutcome } from "@crypto-trading/exchanges/manual-order";

import { approveProposal, rejectProposal } from "@/app/proposal-actions";
import { OutcomeAlert } from "@/components/order-ticket";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Approve & submit, or reject with an optional reason, while the proposal is
 * a draft. The worker runs every check again before it places anything, and
 * places a proposal at most once however often approval is clicked.
 */
export function ProposalActions({
  proposalId,
  status,
  onUpdate,
}: {
  proposalId: string;
  status: ProposalStatus;
  // Called with the proposal as it is after an approval or rejection.
  onUpdate?: (proposal: ProposalView) => void;
}) {
  const [pending, startTransition] = useTransition();
  // Blocks a second click before the first one re-renders the button.
  const sending = useRef(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<ManualOrderOutcome>();
  const [message, setMessage] = useState<string>();
  const reasonId = useId();

  function run(task: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        await task();
      } finally {
        sending.current = false;
      }
    });
  }

  const approve = () =>
    run(async () => {
      setMessage(undefined);
      const result = await approveProposal(proposalId);
      setOutcome(result.outcome);
      if (result.proposal) onUpdate?.(result.proposal);
    });

  const reject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const result = await rejectProposal({
        proposalId,
        reason: reason.trim() || undefined,
      });
      setOutcome(undefined);
      setMessage(result.message);
      if (result.rejected) setRejecting(false);
      if (result.proposal) onUpdate?.(result.proposal);
    });
  };

  if (status !== "draft" && !outcome && !message) return null;
  return (
    <div className="space-y-2 text-xs">
      {outcome ? <OutcomeAlert outcome={outcome} /> : null}
      {message ? (
        <p className="text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      {status !== "draft" ? null : rejecting ? (
        <form className="space-y-2" onSubmit={reject}>
          <Label htmlFor={reasonId}>Why are you rejecting it? (optional)</Label>
          <Textarea
            disabled={pending}
            id={reasonId}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="For example: the stop loss is too tight."
            rows={2}
            value={reason}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              size="sm"
              type="submit"
              variant="outline"
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <X />}
              Reject proposal
            </Button>
            <Button
              disabled={pending}
              onClick={() => setRejecting(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Keep it
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={approve} size="sm">
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CheckCircle2 />
            )}
            Approve &amp; submit order
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setMessage(undefined);
              setRejecting(true);
            }}
            size="sm"
            variant="outline"
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
