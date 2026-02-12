"use client";

import { FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export function ReportChat({ scanId }: { scanId: string }) {
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask me anything about this scan. I will answer using stored evidence only.",
    },
  ]);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const question = input.trim();

    if (!question || isSending) {
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content: question }];
    setMessages(nextMessages);
    setInput("");
    setIsSending(true);

    try {
      const response = await fetch(`/api/scans/${scanId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: nextMessages }),
      });

      const data = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || !data.message) {
        throw new Error(data.error ?? "Unable to get response");
      }

      setMessages((current) => [...current, { role: "assistant", content: data.message ?? "No response" }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chat request failed";
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${message}` }]);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Card className="scan-panel scan-panel-notch">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm uppercase tracking-[0.22em]">Ask Drona</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-64 space-y-2 overflow-auto rounded-md border border-border/60 bg-muted/20 p-3">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={message.role === "assistant" ? "text-sm text-foreground" : "text-sm text-primary"}
            >
              <span className="mr-2 font-mono text-[11px] uppercase tracking-[0.18em] opacity-70">{message.role}</span>
              {message.content}
            </div>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={onSubmit}>
          <Input
            placeholder="Why is this score medium?"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={isSending}
          />
          <Button type="submit" disabled={!canSend}>
            {isSending ? "..." : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
