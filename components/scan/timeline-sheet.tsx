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

export function TimelineSheet({ scanId, open, onOpenChange }: TimelineSheetProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }

    fetch(`/api/scans/${scanId}/events?after=0`)
      .then((response) => response.json())
      .then((data: { events?: TimelineEvent[] }) => setEvents(data.events ?? []))
      .catch(() => setEvents([]));
  }, [open, scanId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] border-l border-holo-cyan/25 bg-space-black/90 text-gray-200 backdrop-blur-md"
      >
        <SheetHeader>
          <SheetTitle className="font-mono text-sm uppercase tracking-[0.2em] text-holo-cyan">Run Timeline</SheetTitle>
        </SheetHeader>

        <ScrollArea className="mt-4 h-[calc(100vh-7rem)] pr-3">
          <div className="space-y-2">
            {events.map((event) => (
              <div key={event.id} className="rounded border border-holo-cyan/15 bg-space-dark/70 p-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-holo-cyan/70">{event.type}</p>
                <p className="text-xs text-gray-200">{event.message}</p>
                <p className="font-mono text-[10px] text-gray-500">{new Date(event.ts).toLocaleTimeString()}</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
