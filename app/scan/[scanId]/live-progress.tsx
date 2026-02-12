"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ScanStatus = "queued" | "running" | "complete" | "failed" | "canceled";

type LiveProgressProps = {
  scanId: string;
  initialStatus: string;
};

type StepStatus = "queued" | "running" | "succeeded" | "warning" | "failed";

type StepItem = {
  key: string;
  label: string;
  status: StepStatus;
};

type StreamEvent = {
  id: number;
  level: "info" | "success" | "warning" | "error";
  type: string;
  stepKey: string | null;
  message: string;
};

const STEP_ORDER: Array<{ key: string; label: string }> = [
  { key: "validate_target", label: "Validate target" },
  { key: "agent_plan", label: "Plan investigation" },
  { key: "rpc_bytecode", label: "Fetch bytecode" },
  { key: "rpc_metadata", label: "Read token metadata" },
  { key: "basescan_verification", label: "Check BaseScan verification" },
  { key: "dex_market", label: "Fetch DEX market data" },
  { key: "agent_assessment", label: "Generate AI assessment" },
];

function normalizeStatus(value: string): ScanStatus {
  if (value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "canceled") {
    return value;
  }

  return "queued";
}

function statusClassName(status: StepStatus) {
  if (status === "running") return "text-yellow-500";
  if (status === "succeeded") return "text-green-500";
  if (status === "warning") return "text-amber-500";
  if (status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

export function LiveProgress({ scanId, initialStatus }: LiveProgressProps) {
  const router = useRouter();
  const initialScanStatus = useMemo(() => normalizeStatus(initialStatus), [initialStatus]);
  const [scanStatus, setScanStatus] = useState<ScanStatus>(initialScanStatus);
  const [logs, setLogs] = useState<string[]>([]);
  const [steps, setSteps] = useState<Record<string, StepStatus>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const hasStartedRunRef = useRef(false);

  const stepItems = useMemo<StepItem[]>(() => {
    return STEP_ORDER.map((step) => ({
      ...step,
      status: steps[step.key] ?? "queued",
    }));
  }, [steps]);

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

    const appendLog = (line: string) => {
      if (!isMounted) return;
      setLogs((current) => [...current, line].slice(-200));
    };

    const setStepStatus = (stepKey: string | null, status: StepStatus) => {
      if (!isMounted || !stepKey) return;
      setSteps((current) => ({ ...current, [stepKey]: status }));
    };

    const subscribe = () => {
      const eventSource = new EventSource(`/api/scans/${scanId}/stream`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("step.started", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        setStepStatus(parsed.stepKey, "running");
        appendLog(parsed.message);
      });

      eventSource.addEventListener("step.completed", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        const status = parsed.level === "warning" ? "warning" : "succeeded";
        setStepStatus(parsed.stepKey, status);
        appendLog(parsed.message);
      });

      eventSource.addEventListener("step.failed", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        setStepStatus(parsed.stepKey, "failed");
        appendLog(parsed.message);
        setScanStatus("failed");
      });

      eventSource.addEventListener("log.line", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent;
        appendLog(parsed.message);
      });

      eventSource.addEventListener("artifact.plan", (event) => {
        const parsed = JSON.parse((event as MessageEvent).data) as StreamEvent & {
          payload?: { fallback?: boolean; steps?: Array<{ title?: string }> };
        };
        const fallback = parsed.payload?.fallback ? " (fallback)" : "";
        appendLog(`Plan ready${fallback}`);
      });

      eventSource.addEventListener("assessment.final", () => {
        appendLog("Assessment generated");
      });

      eventSource.addEventListener("run.started", () => {
        setScanStatus("running");
      });

      eventSource.addEventListener("run.completed", () => {
        setScanStatus("complete");
        eventSource?.close();
        eventSourceRef.current = null;
        router.refresh();
      });

      eventSource.addEventListener("run.failed", () => {
        setScanStatus("failed");
        eventSource?.close();
        eventSourceRef.current = null;
        router.refresh();
      });

      eventSource.addEventListener("end", () => {
        eventSource?.close();
        eventSourceRef.current = null;
      });

      eventSource.onerror = () => {
        eventSource?.close();
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

  if (scanStatus !== "queued" && scanStatus !== "running" && logs.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-4 rounded-lg border bg-card p-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-3">
        <p className="text-sm font-medium">Scan Steps</p>
        <p className="text-xs text-muted-foreground">Status: {scanStatus}</p>
        <div className="space-y-2">
          {stepItems.map((step) => (
            <div key={step.key} className="rounded border px-3 py-2">
              <p className="text-sm font-medium">{step.label}</p>
              <p className={`text-xs ${statusClassName(step.status)}`}>{step.status}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Terminal</p>
        <div className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
          {logs.length === 0 ? <p className="text-muted-foreground">Waiting for run events...</p> : null}
          {logs.map((line, idx) => (
            <p key={`${line}-${idx}`} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
