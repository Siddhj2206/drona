"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HudHeader } from "@/components/scan/hud-header";
import { TimelineSheet } from "@/components/scan/timeline-sheet";
import { ReportChat } from "@/components/scan/report-chat";

type ScoreReason = {
  title: string;
  detail: string;
  evidenceRefs: string[];
};

type AgentScore = {
  overallScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  reasons: ScoreReason[];
  missingData: string[];
};

type EvidenceItem = {
  id: string;
  tool: string;
  title: string;
  status: "ok" | "unavailable";
  fetchedAt: string;
  error: string | null;
  data?: Record<string, unknown>;
};

type ReportViewProps = {
  scanId: string;
  tokenAddress: string;
  status: string;
  createdAtIso: string;
  narrative: string | null;
  score: unknown;
  evidence: unknown;
  error: string | null;
};

function isAgentScore(value: unknown): value is AgentScore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentScore>;
  return (
    typeof candidate.overallScore === "number" &&
    typeof candidate.riskLevel === "string" &&
    typeof candidate.confidence === "string" &&
    Array.isArray(candidate.reasons)
  );
}

function getEvidenceItems(value: unknown): EvidenceItem[] {
  if (!value || typeof value !== "object") return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  return items.filter((item): item is EvidenceItem => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<EvidenceItem>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.tool === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.status === "string" &&
      typeof candidate.fetchedAt === "string"
    );
  });
}

export function ReportView({
  scanId,
  tokenAddress,
  status,
  createdAtIso,
  narrative,
  score,
  evidence,
  error,
}: ReportViewProps) {
  const [hudVisible, setHudVisible] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const agentScore = useMemo(() => (isAgentScore(score) ? score : null), [score]);
  const evidenceItems = useMemo(() => getEvidenceItems(evidence), [evidence]);

  const riskColor =
    agentScore?.riskLevel === "critical"
      ? "text-[#ff0055]"
      : agentScore?.riskLevel === "high"
        ? "text-orange-300"
        : agentScore?.riskLevel === "medium"
          ? "text-yellow-300"
          : "text-[#00ff94]";

  return (
    <main className="h-screen w-screen relative">
      <HudHeader
        showHudToggle
        hudVisible={hudVisible}
        onToggleHud={() => setHudVisible((current) => !current)}
        showTimelineButton
        onOpenTimeline={() => setTimelineOpen(true)}
      />

      <TimelineSheet scanId={scanId} open={timelineOpen} onOpenChange={setTimelineOpen} />

      <div className="absolute inset-0 z-0 transition-all duration-700">
        <div className={`absolute inset-0 transition-all duration-700 ${hudVisible ? "opacity-20" : "opacity-100"}`}>
          <div className="absolute inset-0 opacity-25 bg-[linear-gradient(rgba(0,243,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.1)_1px,transparent_1px)] bg-[length:26px_26px]" />
          <div className="absolute inset-0 flex items-center justify-center text-[#00f3ff]/65">
            <p className="font-mono text-xs uppercase tracking-[0.28em]">Graph Placeholder</p>
          </div>
        </div>
        {hudVisible ? <div className="absolute inset-0 bg-[#030014]/40 backdrop-blur-sm" /> : null}
      </div>

      {hudVisible ? (
        <div className="absolute inset-0 z-10 grid grid-cols-12 grid-rows-6 gap-4 px-4 pt-16 pb-4 pointer-events-none">
          <Card className="scan-panel clip-corner-bl tech-border-glow pointer-events-auto relative col-span-12 row-span-2 overflow-hidden border-[#ff0055]/30 md:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-xs uppercase tracking-[0.22em] text-[#ff0055]">Threat_Assessment</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-6xl font-bold ${riskColor}`}>{agentScore?.overallScore ?? "--"}</p>
              <p className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-gray-300">
                {agentScore?.riskLevel ?? "unknown"}_risk
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00f3ff]/60">
                Confidence: {agentScore?.confidence ?? "unknown"}
              </p>
            </CardContent>
          </Card>

          <Card className="scan-panel clip-notch tech-border-glow pointer-events-auto col-span-12 row-span-4 overflow-hidden md:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-xs uppercase tracking-[0.22em] text-[#00f3ff]">Target_Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/60">Address</p>
                <p className="font-mono text-xs text-gray-300 break-all">{tokenAddress}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/60">Created</p>
                <p className="text-gray-300">{new Date(createdAtIso).toLocaleString()}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/60">Status</p>
                <p className="text-gray-300 uppercase">{status}</p>
              </div>
              {error ? <p className="text-xs text-[#ff0055]">{error}</p> : null}
            </CardContent>
          </Card>

          <div className="pointer-events-auto col-span-12 row-span-6 flex flex-col gap-4 md:col-span-6">
            <Card className="scan-panel tech-border-glow flex-1">
              <CardHeader className="pb-3">
                <CardTitle className="font-mono text-xs uppercase tracking-[0.22em] text-[#00f3ff]">AI_Forensic_Review</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-gray-200">{narrative ?? "No narrative available yet."}</p>
              </CardContent>
            </Card>

            <div className="grid flex-[1.4] grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="scan-panel">
                <CardHeader className="pb-3">
                  <CardTitle className="font-mono text-xs uppercase tracking-[0.22em] text-[#00f3ff]">Vulnerability_Scan</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  {(agentScore?.reasons ?? []).map((reason) => (
                    <div key={reason.title} className="rounded border border-[#00f3ff]/20 bg-[#00f3ff]/5 p-2">
                      <p className="font-semibold text-gray-100">{reason.title}</p>
                      <p className="text-gray-300">{reason.detail}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="scan-panel">
                <CardHeader className="pb-3">
                  <CardTitle className="font-mono text-xs uppercase tracking-[0.22em] text-[#00f3ff]">Distribution_Matrix</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#ff0055]/75">DATA_UNAVAILABLE</p>
                  <p className="mt-2 text-xs text-gray-300">
                    Real holder distribution source is not connected yet. This panel remains unavailable until then.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="pointer-events-auto col-span-12 row-span-6 md:col-span-3">
            <ReportChat scanId={scanId} />
          </div>
        </div>
      ) : null}

      <div className="hidden">
        <pre>{JSON.stringify(evidenceItems.length, null, 2)}</pre>
      </div>

      {hudVisible ? null : (
        <div className="pointer-events-none absolute right-6 bottom-6 z-20">
          <Button
            type="button"
            className="pointer-events-auto border border-[#00f3ff]/40 bg-[#030014]/70 font-mono text-xs uppercase tracking-[0.18em]"
            onClick={() => setHudVisible(true)}
          >
            Show_HUD
          </Button>
        </div>
      )}
    </main>
  );
}
