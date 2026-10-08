"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import { Bot, Send, Square } from "lucide-react";
import { useEveAgent, type EveMessagePart } from "eve/react";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import { AssistantToolPart } from "@/components/assistant-tool-part";
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

// Distance from the bottom, in pixels, that still counts as following the
// conversation.
const FOLLOW_THRESHOLD_PX = 48;

const starterPrompts = [
  { icon: "📊", prompt: "Analyze my BTC allocation and exposure" },
  { icon: "⚠️", prompt: "Check for high-risk open orders" },
  { icon: "💡", prompt: "Suggest a limit buy strategy for ETH" },
];

export function AssistantPanel({
  accountSnapshot,
  accountLabel,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const agent = useEveAgent();
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const messages = agent.data.messages;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const restoreInputFocus = useRef(false);

  // Keep the newest message in view while the reader is following along,
  // but leave the scroll position alone once they scroll up to read history.
  // Scroll before paint so streamed text never shows below the fold first.
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followLatest.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [messages, agent.error]);

  // The input is disabled during a turn, which drops its focus. Give focus
  // back when the turn ends unless the reader has moved it elsewhere.
  useEffect(() => {
    if (busy || !restoreInputFocus.current) return;
    restoreInputFocus.current = false;
    if (
      document.activeElement === null ||
      document.activeElement === document.body
    ) {
      inputRef.current?.focus();
    }
  }, [busy]);

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    followLatest.current =
      scrollHeight - scrollTop - clientHeight <= FOLLOW_THRESHOLD_PX;
  }

  // Enter sends and Shift+Enter starts a new line. Enter that confirms an IME
  // composition must not send; Safari reports that keydown as keyCode 229.
  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function applyStarterPrompt(prompt: string) {
    setDraft(prompt);
    inputRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    followLatest.current = true;
    restoreInputFocus.current = true;
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
        <div
          aria-label="Conversation with the analysis assistant"
          className="mb-4 max-h-[28rem] min-h-32 space-y-3 overflow-y-auto overscroll-contain rounded-lg border border-border bg-background/45 p-3"
          onScroll={handleTranscriptScroll}
          ref={transcriptRef}
          role="log"
          tabIndex={0}
        >
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
                {message.parts.map((part, index) => (
                  <MessagePart
                    key={
                      part.type === "dynamic-tool"
                        ? part.toolCallId
                        : `${message.id}-${index}`
                    }
                    part={part}
                    role={message.role}
                  />
                ))}
              </div>
            ))
          )}
          {agent.error ? (
            <p className="text-sm text-destructive">{agent.error.message}</p>
          ) : null}
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          {messages.length === 0 ? (
            <div
              aria-label="Starter prompts"
              className="flex flex-wrap gap-1.5"
              role="group"
            >
              {starterPrompts.map(({ icon, prompt }) => (
                <Button
                  className="h-auto min-h-6 py-1 text-left whitespace-normal"
                  disabled={busy}
                  key={prompt}
                  onClick={() => applyStarterPrompt(prompt)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <span aria-hidden="true">{icon}</span>
                  {prompt}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            aria-label="Message the analysis assistant"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="What happened in my latest BTC trade?"
            ref={inputRef}
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

function MessagePart({
  part,
  role,
}: {
  part: EveMessagePart;
  role: "assistant" | "user";
}) {
  switch (part.type) {
    case "text":
      return role === "assistant" ? (
        <AssistantMarkdown text={part.text} />
      ) : (
        <p className="text-sm leading-5 whitespace-pre-wrap">{part.text}</p>
      );
    case "dynamic-tool":
      return <AssistantToolPart part={part} />;
    default:
      // Reasoning, step boundaries, attachments and authorization prompts are
      // not shown: the panel sends text only and the agent has no connections.
      return null;
  }
}
