"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";

type TimelineSheetProps = {
  scanId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type TimelineEvent = {
  id: number;
  ts: string;
  type: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  stepKey: string | null;
};

function levelStyles(level: TimelineEvent["level"]) {
  if (level === "error") {
    return {
      chip: "border-[#ff0055]/60 bg-[#ff0055]/10 text-[#ff0055]",
      border: "border-[#ff0055]/35",
    };
  }

  if (level === "warning") {
    return {
      chip: "border-[#bc13fe]/60 bg-[#bc13fe]/12 text-[#bc13fe]",
      border: "border-[#bc13fe]/35",
    };
  }

  if (level === "success") {
    return {
      chip: "border-[#00ff94]/60 bg-[#00ff94]/12 text-[#00ff94]",
      border: "border-[#00ff94]/35",
    };
  }

  return {
    chip: "border-[#00f3ff]/45 bg-[#00f3ff]/10 text-[#00f3ff]",
    border: "border-[#00f3ff]/25",
  };
}

function formatType(type: string) {
  return type.replaceAll(".", "_").toUpperCase();
}

export function TimelineSheet({ scanId, open, onOpenChange }: TimelineSheetProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    fetch(`/api/scans/${scanId}/events?after=0`)
      .then((response) => response.json())
      .then((data: { events?: TimelineEvent[] }) => setEvents(data.events ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoadedOnce(true));
  }, [open, scanId]);

  const loading = open && !loadedOnce;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[440px] border-l border-[#00f3ff]/25 bg-[#030014]/90 text-gray-200 backdrop-blur-md"
      >
        <SheetHeader className="border-b border-[#00f3ff]/12 bg-[#00f3ff]/5 px-1 pb-3">
          <SheetTitle className="font-mono text-sm uppercase tracking-[0.22em] text-[#00f3ff]">Run Timeline</SheetTitle>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/55">SCAN::{scanId.slice(0, 8)}</p>
        </SheetHeader>

        <ScrollArea className="mt-4 h-[calc(100vh-7.5rem)] pr-3">
          {loading ? <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#00f3ff]/60">Loading timeline...</p> : null}

          {!loading && events.length === 0 ? (
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-gray-500">No timeline events available.</p>
          ) : null}

          <div className="space-y-2">
            {events.map((event) => {
              const styles = levelStyles(event.level);

              return (
                <div
                  key={event.id}
                  className={`rounded border bg-[#0a0a1f]/75 p-3 shadow-[inset_0_0_16px_rgba(0,243,255,0.04)] ${styles.border}`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/75">{formatType(event.type)}</p>
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] ${styles.chip}`}>
                      {event.level}
                    </span>
                  </div>

                  <p className="text-xs leading-relaxed text-gray-200">{event.message}</p>

                  <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-gray-500">
                    <span>{new Date(event.ts).toLocaleTimeString()}</span>
                    <span>{event.stepKey ? `STEP::${event.stepKey.toUpperCase()}` : "STEP::N/A"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
