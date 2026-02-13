"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { AddressGraph } from "@/components/scan/address-graph";
import { buildAddressGraphData, type GraphEvidenceItem } from "@/lib/graph/address-graph";
import { HudHeader } from "@/components/scan/hud-header";

type ScanStatus = "queued" | "running" | "complete" | "failed" | "canceled";

type LiveProgressProps = {
  scanId: string;
  tokenAddress: string;
  initialStatus: string;
};

type LogLevel = "info" | "success" | "warning" | "error";

type LogItem = {
  ts: string;
  message: string;
  level: LogLevel;
};

type StreamEvent = {
  id?: number;
  type?: string;
  stepKey?: string | null;
  ts: string;
  level: LogLevel;
  message: string;
  payload?: unknown;
};

type StreamPlanPayload = {
  fallback?: boolean;
};

const MAX_LOGS = 240;

function addLog(setter: Dispatch<SetStateAction<LogItem[]>>, item: LogItem) {
  setter((current) => [...current, item].slice(-MAX_LOGS));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGraphEvidenceItem(payload: unknown): payload is GraphEvidenceItem {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as Partial<GraphEvidenceItem>;
  return typeof candidate.tool === "string" && typeof candidate.status === "string";
}

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

export function LiveProgress({ scanId, tokenAddress, initialStatus }: LiveProgressProps) {
  const router = useRouter();
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const hasStartedRunRef = useRef(false);
  const initialScanStatus = useMemo(() => normalizeStatus(initialStatus), [initialStatus]);

  const [scanStatus, setScanStatus] = useState<ScanStatus>(initialScanStatus);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [evidenceItems, setEvidenceItems] = useState<GraphEvidenceItem[]>([]);
  const graphData = useMemo(() => buildAddressGraphData(tokenAddress, evidenceItems), [tokenAddress, evidenceItems]);
  const scanStatusRef = useRef<ScanStatus>(initialScanStatus);

  useEffect(() => {
    scanStatusRef.current = scanStatus;
  }, [scanStatus]);

  useEffect(() => {
    if (initialScanStatus !== "queued") {
      return;
    }

    if (hasStartedRunRef.current) {
      return;
    }

    hasStartedRunRef.current = true;
    let cancelled = false;

    const triggerRun = async () => {
      const delays = [0, 900, 1800];

      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        if (cancelled) {
          return;
        }

        if (attempt > 0) {
          addLog(setLogs, {
            ts: new Date().toISOString(),
            level: "warning",
            message: `Run trigger retry ${attempt + 1}/${delays.length}...`,
          });
        }

        if (delays[attempt] > 0) {
          await wait(delays[attempt]);
          if (cancelled) {
            return;
          }
        }

        try {
          const response = await fetch(`/api/scans/${scanId}/run`, {
            method: "POST",
            headers: {
              "Cache-Control": "no-store",
            },
          });

          if (!response.ok) {
            throw new Error(`run endpoint returned ${response.status}`);
          }

          addLog(setLogs, {
            ts: new Date().toISOString(),
            level: "info",
            message: "Run trigger accepted.",
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          addLog(setLogs, {
            ts: new Date().toISOString(),
            level: "warning",
            message: `Run trigger failed: ${message}`,
          });
        }
      }

      addLog(setLogs, {
        ts: new Date().toISOString(),
        level: "error",
        message: "Unable to trigger scan run automatically. Refresh or retry.",
      });
    };

    void triggerRun();

    return () => {
      cancelled = true;
    };
  }, [scanId, initialScanStatus]);

  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const appendLog = (item: LogItem) => {
      if (!isMounted) return;

      addLog(setLogs, item);
    };

    const scheduleReconnect = () => {
      if (!isMounted) {
        return;
      }
      if (!(scanStatusRef.current === "queued" || scanStatusRef.current === "running")) {
        return;
      }

      reconnectAttempts += 1;
      const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 3), 8000);
      appendLog({
        ts: new Date().toISOString(),
        level: "warning",
        message: `Stream interrupted, reconnecting in ${Math.round(delay / 1000)}s...`,
      });

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      reconnectTimer = setTimeout(() => {
        if (!isMounted) {
          return;
        }
        subscribe();
      }, delay);
    };

    const subscribe = () => {
      const eventSource = new EventSource(`/api/scans/${scanId}/stream`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("ready", () => {
        reconnectAttempts = 0;
        appendLog({
          ts: new Date().toISOString(),
          level: "info",
          message: "Stream connected.",
        });
      });

      const pushEvent = (event: Event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        appendLog({ ts: parsed.ts, message: parsed.message, level: parsed.level });
      };

      eventSource.addEventListener("step.started", pushEvent);
      eventSource.addEventListener("step.completed", pushEvent);
      eventSource.addEventListener("step.failed", pushEvent);
      eventSource.addEventListener("log.line", pushEvent);
      eventSource.addEventListener("evidence.item", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        appendLog({ ts: parsed.ts, message: parsed.message, level: parsed.level });

        if (!isGraphEvidenceItem(parsed.payload)) {
          return;
        }

        const evidenceItem = parsed.payload;
        const dedupeKey = evidenceItem.id ?? `${evidenceItem.tool}-${parsed.stepKey ?? "unknown"}`;

        setEvidenceItems((current) => {
          const existingIndex = current.findIndex((item) => (item.id ?? item.tool) === dedupeKey || item.id === evidenceItem.id);

          if (existingIndex === -1) {
            return [...current, evidenceItem];
          }

          const next = [...current];
          next[existingIndex] = evidenceItem;
          return next;
        });
      });

      eventSource.addEventListener("artifact.plan", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        const fallback = (parsed.payload as StreamPlanPayload | undefined)?.fallback ? " (fallback)" : "";
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
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        router.refresh();
      });

      eventSource.addEventListener("run.failed", () => {
        setScanStatus("failed");
        eventSource.close();
        eventSourceRef.current = null;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        router.refresh();
      });

      eventSource.addEventListener("end", () => {
        eventSource.close();
        eventSourceRef.current = null;
      });

      eventSource.onerror = () => {
        eventSource.close();
        eventSourceRef.current = null;
        scheduleReconnect();
      };
    };

    if (scanStatus === "queued" || scanStatus === "running") {
      subscribe();
    }

    return () => {
      isMounted = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [router, scanId, scanStatus]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  return (
    <main className="h-screen w-screen relative">
      <HudHeader />

      <div className="flex h-full items-center justify-center px-6 pt-16 pb-6">
        <div className="flex h-full w-full gap-4">
          <div className="relative h-full w-1/4 overflow-hidden border-r border-[#00f3ff]/20 bg-[#030014]/80 backdrop-blur-md">
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

          <div className="relative h-full w-3/4">
            <div className="absolute inset-0 border-y border-[#00f3ff]/10 bg-[#00f3ff]/5" />
            <p className="absolute top-4 right-4 font-mono text-xs text-[#00f3ff]/60 animate-pulse">
              LIVE_FEED::GRAPH_VISUALIZER
            </p>

            <div className="relative h-full w-full overflow-hidden rounded-lg border border-[#00f3ff]/20 bg-[#030014]/40">
              <div className="absolute inset-0 opacity-20 bg-[linear-gradient(rgba(0,243,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.1)_1px,transparent_1px)] bg-[length:20px_20px]" />

              <div className="relative h-full w-full">
                <AddressGraph data={graphData} className="h-full w-full" />
                <div className="pointer-events-none absolute top-4 left-4 rounded border border-[#00f3ff]/25 bg-[#030014]/80 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/75">
                  {scanStatus} :: {graphData.nodes.length} nodes / {graphData.links.length} links
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
