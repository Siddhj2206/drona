"use client";

import { FormEvent, useMemo, useState } from "react";
import { Send } from "lucide-react";

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
    <div className="h-full overflow-hidden rounded-lg border border-[#00f3ff]/20 bg-[#030014]/60 backdrop-blur-md tech-border-glow">
      <div className="border-b border-[#00f3ff]/10 bg-[#00f3ff]/5 p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#00ff94] animate-ping-slow" />
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#00f3ff]">Comms_Link::Secure</p>
        </div>
      </div>

      <div className="scrollbar-hide h-[calc(100%-8.5rem)] overflow-y-auto p-4 space-y-6">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[92%] rounded px-3 py-2 text-sm ${
                message.role === "user"
                  ? "border-r-2 border-[#00f3ff] bg-[#00f3ff]/10 text-white"
                  : "border-l-2 border-[#bc13fe]/50 bg-[#bc13fe]/5 text-gray-300"
              }`}
            >
              {message.role === "assistant" ? (
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[#00f3ff]/50">Agent_Scout</p>
              ) : null}
              {message.content}
            </div>
          </div>
        ))}

        {isSending ? (
          <div className="flex justify-start">
            <div className="rounded border-l-2 border-[#bc13fe]/50 bg-[#bc13fe]/5 px-3 py-2 text-sm text-[#00f3ff] animate-pulse">
              Thinking...
            </div>
          </div>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-[#00f3ff]/10 bg-black/40 p-4">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={isSending}
          placeholder="Ask about risk signals..."
          className="w-full border-b border-[#00f3ff]/20 bg-transparent px-1 pb-2 font-mono text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00f3ff]"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="text-[#00f3ff] hover:text-white disabled:opacity-40"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
