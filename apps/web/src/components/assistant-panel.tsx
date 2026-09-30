"use client";

import { useState, type FormEvent } from "react";
import { Bot, Send, Square } from "lucide-react";
import { useEveAgent } from "eve/react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

type JsonObject = {
  [key: string]: JsonValue;
};

type AssistantPanelProps = {
  accountSnapshot: JsonObject;
  accountLabel: string;
};

export function AssistantPanel({
  accountSnapshot,
  accountLabel,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const agent = useEveAgent();
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const messages = agent.data.messages.slice(-3);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    setDraft("");
    await agent.send(message, {
      clientContext: {
        route: "/",
        account: accountLabel,
        mode: "testnet",
        accountSnapshot,
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Bot className="size-4" />
          </div>
          <div>
            <CardTitle>Analysis assistant</CardTitle>
            <CardDescription>
              Explains activity and drafts changes.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 min-h-32 space-y-3 rounded-lg border border-border bg-background/45 p-3">
          {messages.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              Ask about your balances, recent trades, or open orders. The
              assistant uses the account snapshot shown here.
            </p>
          ) : (
            messages.map((message) => (
              <div
                className={
                  message.role === "user"
                    ? "ml-6 text-foreground"
                    : "mr-6 text-muted-foreground"
                }
                key={message.id}
              >
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider">
                  {message.role === "user" ? "You" : "Assistant"}
                </p>
                {message.parts.map((part, index) =>
                  part.type === "text" ? (
                    <p
                      className="text-sm leading-5"
                      key={`${message.id}-${index}`}
                    >
                      {part.text}
                    </p>
                  ) : null,
                )}
              </div>
            ))
          )}
          {agent.error ? (
            <p className="text-sm text-destructive">{agent.error.message}</p>
          ) : null}
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          <Textarea
            aria-label="Message the analysis assistant"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What happened in my latest BTC trade?"
            rows={3}
            value={draft}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {busy ? "Analyzing account data…" : "Testnet account analysis"}
            </p>
            {busy ? (
              <Button
                onClick={() => void agent.cancel()}
                size="sm"
                type="button"
                variant="outline"
              >
                <Square className="size-3.5" />
                Stop
              </Button>
            ) : (
              <Button disabled={!draft.trim()} size="sm" type="submit">
                <Send className="size-4" />
                Send
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
