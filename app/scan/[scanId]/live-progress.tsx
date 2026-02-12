"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TerminalSquare } from "lucide-react";
import { HudHeader } from "@/components/scan/hud-header";

type ScanStatus = "queued" | "running" | "complete" | "failed" | "canceled";

type LiveProgressProps = {
  scanId: string;
  initialStatus: string;
};

type LogLevel = "info" | "success" | "warning" | "error";

type LogItem = {
  ts: string;
  message: string;
  level: LogLevel;
};

type StreamEvent = {
  ts: string;
  level: LogLevel;
  message: string;
  payload?: {
    fallback?: boolean;
  };
};

function normalizeStatus(value: string): ScanStatus {
  if (value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "canceled") {
    return value;
  }

  return "queued";
}

function levelClass(level: LogLevel) {
  if (level === "error") return "text-[#ff0055] font-bold";
  if (level === "success") return "text-[#00ff94]";
  if (level === "warning") return "text-[#bc13fe]";
  return "text-gray-300";
}

export function LiveProgress({ scanId, initialStatus }: LiveProgressProps) {
  const router = useRouter();
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const hasStartedRunRef = useRef(false);
  const initialScanStatus = useMemo(() => normalizeStatus(initialStatus), [initialStatus]);

  const [scanStatus, setScanStatus] = useState<ScanStatus>(initialScanStatus);
  const [logs, setLogs] = useState<LogItem[]>([]);

  useEffect(() => {
    if (initialScanStatus !== "queued") {
      return;
    }

    if (hasStartedRunRef.current) {
      return;
    }

    hasStartedRunRef.current = true;
    fetch(`/api/scans/${scanId}/run`, { method: "POST" }).catch(() => null);
  }, [scanId, initialScanStatus]);

  useEffect(() => {
    let isMounted = true;

    const appendLog = (item: LogItem) => {
      if (!isMounted) return;

      setLogs((current) => [...current, item].slice(-240));
    };

    const subscribe = () => {
      const eventSource = new EventSource(`/api/scans/${scanId}/stream`);
      eventSourceRef.current = eventSource;

      const pushEvent = (event: Event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        appendLog({ ts: parsed.ts, message: parsed.message, level: parsed.level });
      };

      eventSource.addEventListener("step.started", pushEvent);
      eventSource.addEventListener("step.completed", pushEvent);
      eventSource.addEventListener("step.failed", pushEvent);
      eventSource.addEventListener("log.line", pushEvent);
      eventSource.addEventListener("evidence.item", pushEvent);

      eventSource.addEventListener("artifact.plan", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        const fallback = parsed.payload?.fallback ? " (fallback)" : "";
        appendLog({ ts: parsed.ts, message: `Plan ready${fallback}`, level: "info" });
      });

      eventSource.addEventListener("assessment.final", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        appendLog({ ts: parsed.ts, message: "Assessment generated", level: "success" });
      });

      eventSource.addEventListener("run.started", () => {
        setScanStatus("running");
      });

      eventSource.addEventListener("run.completed", () => {
        setScanStatus("complete");
        eventSource.close();
        eventSourceRef.current = null;
        router.refresh();
      });

      eventSource.addEventListener("run.failed", () => {
        setScanStatus("failed");
        eventSource.close();
        eventSourceRef.current = null;
        router.refresh();
      });

      eventSource.addEventListener("end", () => {
        eventSource.close();
        eventSourceRef.current = null;
      });

      eventSource.onerror = () => {
        eventSource.close();
        eventSourceRef.current = null;
      };
    };

    if (initialScanStatus === "queued" || initialScanStatus === "running") {
      subscribe();
    }

    return () => {
      isMounted = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [initialScanStatus, router, scanId]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  return (
    <main className="h-screen w-screen relative">
      <HudHeader />

      <div className="flex h-full items-center justify-center px-6 pt-16 pb-6">
        <div className="flex h-full w-full gap-4">
          <div className="relative h-full w-1/3 overflow-hidden border-r border-[#00f3ff]/20 bg-[#030014]/80 backdrop-blur-md">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#00f3ff] to-transparent opacity-50" />

            <div className="flex h-full flex-col p-6 text-xs font-mono">
              <div className="mb-4 flex items-center justify-between border-b border-[#00f3ff]/20 pb-2">
                <p className="text-[10px] uppercase tracking-widest text-[#00f3ff]/70">{"/// SYSTEM_LOG.DAT"}</p>
                <p className="text-[10px] text-gray-500 animate-pulse">RECORDING...</p>
              </div>

              <div ref={terminalRef} className="scrollbar-hide flex-1 space-y-2 overflow-y-auto">
                {logs.map((log, index) => (
                  <div key={`${log.ts}-${log.message}-${index}`} className="flex gap-3">
                    <p className="min-w-[68px] text-[10px] text-gray-600">{new Date(log.ts).toLocaleTimeString()}</p>
                    <p className={`scan-terminal-line ${levelClass(log.level)}`}>
                      {log.level === "info" ? <span className="mr-1 text-[#00f3ff]/70">›</span> : null}
                      {log.message}
                    </p>
                  </div>
                ))}
                <p className="text-[#00f3ff] animate-pulse">_</p>
              </div>
            </div>
          </div>

          <div className="relative h-full w-2/3">
            <div className="absolute inset-0 border-y border-[#00f3ff]/10 bg-[#00f3ff]/5" />
            <p className="absolute top-4 right-4 font-mono text-xs text-[#00f3ff]/60 animate-pulse">
              LIVE_FEED::GRAPH_VISUALIZER
            </p>

            <div className="relative h-full w-full overflow-hidden rounded-lg border border-[#00f3ff]/20 bg-[#030014]/40">
              <div className="absolute inset-0 opacity-20 bg-[linear-gradient(rgba(0,243,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.1)_1px,transparent_1px)] bg-[length:20px_20px]" />

              <div className="relative flex h-full flex-col items-center justify-center gap-5 text-[#00f3ff]/75">
                <TerminalSquare className="h-16 w-16" />
                <p className="font-mono text-xs uppercase tracking-[0.22em]">Graph Placeholder</p>
                <p className="font-mono text-[11px] text-[#00f3ff]/45">Status: {scanStatus}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
