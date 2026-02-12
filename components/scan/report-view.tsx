"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
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

type HolderRow = {
  address: string;
  pctOfSupply: number | null;
  relativeSharePct: number | null;
  isContract: boolean | null;
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

type AuditCheck = {
  id: string;
  label: string;
  status: "safe" | "warning" | "danger";
  detail: string;
  meta?: string;
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

function getHolderDistribution(items: EvidenceItem[]) {
  const holderEvidence = items.find((item) => item.tool === "holders_getTopHolders");

  if (!holderEvidence || holderEvidence.status !== "ok") {
    return {
      available: false,
      error: holderEvidence?.error ?? null,
      top5: [] as HolderRow[],
      top5Pct: null as number | null,
      asOfDate: null as string | null,
    };
  }

  const rawRows = Array.isArray(holderEvidence.data?.topHolders) ? holderEvidence.data.topHolders : [];

  const top5 = rawRows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const candidate = row as {
        address?: unknown;
        pctOfSupply?: unknown;
        relativeSharePct?: unknown;
        isContract?: unknown;
      };

      if (typeof candidate.address !== "string") return null;

      return {
        address: candidate.address,
        pctOfSupply: typeof candidate.pctOfSupply === "number" ? candidate.pctOfSupply : null,
        relativeSharePct: typeof candidate.relativeSharePct === "number" ? candidate.relativeSharePct : null,
        isContract: typeof candidate.isContract === "boolean" ? candidate.isContract : null,
      } satisfies HolderRow;
    })
    .filter((row): row is HolderRow => row !== null)
    .slice(0, 5);

  return {
    available: top5.length > 0,
    error: holderEvidence.error,
    top5,
    top5Pct: typeof holderEvidence.data?.top5Pct === "number" ? holderEvidence.data.top5Pct : null,
    asOfDate: typeof holderEvidence.data?.asOfDate === "string" ? holderEvidence.data.asOfDate : null,
  };
}

function getIdentityFacts(items: EvidenceItem[]) {
  const dex = items.find((item) => item.tool === "dexscreener_getPairs");
  const verify = items.find((item) => item.tool === "basescan_getSourceInfo");

  const bestPair = (dex?.data?.bestPair as { liquidityUsd?: number | null } | undefined) ?? undefined;
  const liquidity = typeof bestPair?.liquidityUsd === "number" ? `$${Math.round(bestPair.liquidityUsd).toLocaleString()}` : "UNKNOWN";
  const verifiedRaw = verify?.data?.isVerified;
  const verified = verifiedRaw === true ? "YES" : verifiedRaw === false ? "NO" : "UNKNOWN";

  return {
    marketCap: "UNKNOWN",
    liquidity,
    verified,
    honeypot: "UNKNOWN",
  };
}

function getAuditChecks(agentScore: AgentScore | null, holderDistribution: ReturnType<typeof getHolderDistribution>, items: EvidenceItem[]): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const bytecode = items.find((item) => item.tool === "rpc_getBytecode");
  const metadata = items.find((item) => item.tool === "rpc_getErc20Metadata");
  const verify = items.find((item) => item.tool === "basescan_getSourceInfo");
  const dex = items.find((item) => item.tool === "dexscreener_getPairs");
  const holders = items.find((item) => item.tool === "holders_getTopHolders");

  const hasCode = bytecode?.data?.hasCode === true;
  const bytecodeSize = typeof bytecode?.data?.bytecodeSizeBytes === "number" ? bytecode.data.bytecodeSizeBytes : null;
  checks.push({
    id: "contract-code",
    label: "Contract Bytecode",
    status: hasCode ? "safe" : "danger",
    detail: hasCode ? "Contract bytecode detected on Base" : "No contract bytecode detected",
    meta: bytecodeSize !== null ? `Bytecode size: ${bytecodeSize.toLocaleString()} bytes` : undefined,
  });

  const hasTokenMetadata =
    typeof metadata?.data?.name === "string" &&
    typeof metadata?.data?.symbol === "string" &&
    typeof metadata?.data?.decimals === "number";
  checks.push({
    id: "token-metadata",
    label: "Token Metadata",
    status: hasTokenMetadata ? "safe" : "warning",
    detail: hasTokenMetadata ? "ERC-20 metadata available" : "Metadata incomplete or unavailable",
    meta:
      hasTokenMetadata && typeof metadata?.data?.name === "string" && typeof metadata?.data?.symbol === "string"
        ? `${metadata.data.name} (${metadata.data.symbol})`
        : undefined,
  });

  const verifiedRaw = verify?.data?.isVerified;
  checks.push({
    id: "verification",
    label: "Contract Verification",
    status: verifiedRaw === true ? "safe" : verifiedRaw === false ? "warning" : "warning",
    detail: verifiedRaw === true ? "Source code verified" : "Verification unavailable or unverified",
    meta: verify?.error ?? undefined,
  });

  const hasDex = dex?.status === "ok";
  const dexBestPair = (dex?.data?.bestPair as { liquidityUsd?: number; priceChangeH24?: number; volumeH24?: number } | undefined) ?? undefined;
  const liquidity = typeof dexBestPair?.liquidityUsd === "number" ? dexBestPair.liquidityUsd : null;
  const priceChange = typeof dexBestPair?.priceChangeH24 === "number" ? Math.abs(dexBestPair.priceChangeH24) : null;
  const volume = typeof dexBestPair?.volumeH24 === "number" ? dexBestPair.volumeH24 : null;

  checks.push({
    id: "market",
    label: "Market Data",
    status:
      !hasDex
        ? "warning"
        : liquidity !== null && liquidity < 25_000
          ? "danger"
          : liquidity !== null && liquidity < 100_000
            ? "warning"
            : "safe",
    detail: hasDex ? "DEX market evidence collected" : "DEX data unavailable",
    meta:
      hasDex && liquidity !== null
        ? `Liquidity: $${Math.round(liquidity).toLocaleString()} | 24h Δ: ${priceChange?.toFixed(2) ?? "--"}% | Vol: $${
            volume !== null ? Math.round(volume).toLocaleString() : "--"
          }`
        : undefined,
  });

  if (holderDistribution.available) {
    const concentration = holderDistribution.top5Pct ?? null;
    const nonContractCount = holderDistribution.top5.filter((holder) => holder.isContract === false).length;
    const highWalletCount = holderDistribution.top5.filter((holder) => {
      const pct = holder.pctOfSupply ?? holder.relativeSharePct;
      return holder.isContract !== true && typeof pct === "number" && pct >= 10;
    }).length;

    checks.push({
      id: "holders",
      label: "Holder Concentration",
      status:
        concentration === null
          ? "warning"
          : concentration > 60
            ? "danger"
            : concentration > 35
              ? "warning"
              : "safe",
      detail:
        concentration !== null
          ? `Top 5 hold ${concentration.toFixed(2)}% of supply`
          : "Supply-based concentration unavailable (relative share mode)",
      meta: `Top wallets: ${nonContractCount} EOA / ${holderDistribution.top5.length - nonContractCount} contract | >=10% wallets: ${highWalletCount}`,
    });
  } else {
    checks.push({
      id: "holders",
      label: "Holder Concentration",
      status: "warning",
      detail: "Holder distribution unavailable",
      meta: holders?.error ?? undefined,
    });
  }

  checks.push({
    id: "sellability",
    label: "Sellability / Honeypot",
    status: "warning",
    detail: "Simulation not implemented yet",
    meta: "No on-chain sell simulation evidence available",
  });

  checks.push({
    id: "assessment",
    label: "AI Assessment",
    status: agentScore && agentScore.confidence === "high" ? "safe" : "warning",
    detail: agentScore ? "Assessment generated" : "Assessment fallback in use",
    meta: agentScore
      ? `Confidence: ${agentScore.confidence.toUpperCase()} | Missing data: ${agentScore.missingData.length}`
      : "No model assessment object",
  });

  if (agentScore) {
    const topReasons = agentScore.reasons.slice(0, 2);

    for (const [index, reason] of topReasons.entries()) {
      checks.push({
        id: `reason-${index + 1}`,
        label: `Reason ${index + 1}`,
        status: index === 0 ? "warning" : "safe",
        detail: reason.title,
        meta: `${reason.detail} | refs: ${reason.evidenceRefs.join(", ")}`,
      });
    }
  }

  return checks;
}

export function ReportView({ scanId, tokenAddress, status, createdAtIso, narrative, score, evidence, error }: ReportViewProps) {
  const [hudVisible, setHudVisible] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const agentScore = useMemo(() => (isAgentScore(score) ? score : null), [score]);
  const evidenceItems = useMemo(() => getEvidenceItems(evidence), [evidence]);
  const holderDistribution = useMemo(() => getHolderDistribution(evidenceItems), [evidenceItems]);
  const identityFacts = useMemo(() => getIdentityFacts(evidenceItems), [evidenceItems]);
  const auditChecks = useMemo(() => getAuditChecks(agentScore, holderDistribution, evidenceItems), [agentScore, holderDistribution, evidenceItems]);

  const riskColor =
    agentScore?.riskLevel === "critical"
      ? "text-[#ff0055]"
      : agentScore?.riskLevel === "high"
        ? "text-[#ff9f43]"
        : agentScore?.riskLevel === "medium"
          ? "text-[#f7d154]"
          : "text-[#00ff94]";

  const forensicReview = useMemo(() => {
    const baseSummary = narrative ?? "No narrative available yet.";

    if (!agentScore) {
      return `${baseSummary} Additional context is limited because assessment metadata is unavailable.`;
    }

    const reasonLine = agentScore.reasons
      .slice(0, 2)
      .map((reason) => `${reason.title}: ${reason.detail}`)
      .join(" ");

    const missingLine =
      agentScore.missingData.length > 0
        ? ` Missing data includes ${agentScore.missingData.slice(0, 2).join("; ")}.`
        : "";

    return `${baseSummary} ${reasonLine}${missingLine}`.trim();
  }, [agentScore, narrative]);

  return (
    <main className="h-screen w-screen relative font-sans overflow-hidden text-[#00f3ff]">
      <HudHeader
        showHudToggle
        hudVisible={hudVisible}
        onToggleHud={() => setHudVisible((current) => !current)}
        showTimelineButton
        onOpenTimeline={() => setTimelineOpen(true)}
      />

      <TimelineSheet scanId={scanId} open={timelineOpen} onOpenChange={setTimelineOpen} />

      <div className="absolute inset-0 pt-16 px-4 pb-4 grid grid-cols-12 grid-rows-6 gap-4 pointer-events-none">
        <div
          className={`col-span-12 row-span-6 absolute inset-0 z-0 transition-all duration-700 ${
            !hudVisible
              ? "opacity-100 pointer-events-auto cursor-grab active:cursor-grabbing"
              : "opacity-20 pointer-events-none"
          }`}
        >
          <div className="absolute inset-0 opacity-20 bg-[linear-gradient(rgba(0,243,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,243,255,0.1)_1px,transparent_1px)] bg-[length:20px_20px]" />
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="font-mono text-xs tracking-[0.22em] uppercase text-[#00f3ff]/70">GRAPH_PLACEHOLDER</p>
          </div>
        </div>

        {hudVisible ? <div className="absolute inset-0 bg-[#030014]/40 backdrop-blur-sm transition-all duration-700" /> : null}

        <div
          className={`col-span-12 row-span-6 grid grid-cols-12 grid-rows-6 gap-4 pointer-events-auto transition-all duration-500 transform ${
            hudVisible ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"
          }`}
        >
          <div className="col-span-12 md:col-span-3 row-span-2 bg-[#030014]/60 backdrop-blur-md border border-[#ff0055]/30 rounded-lg p-4 clip-corner-bl tech-border-glow relative overflow-hidden">
            <div className="absolute top-0 right-0 w-20 h-20 bg-[#ff0055]/15 blur-xl" />
            <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#ff0055] mb-3">Threat_Assessment</p>
            <p className={`text-7xl leading-none font-bold ${riskColor}`}>{agentScore?.overallScore ?? "--"}</p>
            <p className="mt-2 text-xs font-mono uppercase tracking-[0.2em] text-gray-200">
              {agentScore?.riskLevel ?? "unknown"}_risk
            </p>
            <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#00f3ff]/60">
              Score: {agentScore?.overallScore ?? "--"} / Confidence: {agentScore?.confidence ?? "unknown"}
            </p>
          </div>

          <div className="col-span-12 md:col-span-3 row-span-4 bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 clip-notch tech-border-glow relative overflow-hidden">
            <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff] mb-3">Target_Identity</p>

            <div className="space-y-2 text-sm text-gray-300">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/60">Address</p>
              <p className="font-mono text-xs break-all">{tokenAddress}</p>

              <div className="grid grid-cols-2 gap-2 text-xs mt-3">
                <p className="text-gray-500">Market Cap</p>
                <p className="text-right text-gray-200">{identityFacts.marketCap}</p>
                <p className="text-gray-500">Liquidity</p>
                <p className="text-right text-gray-200">{identityFacts.liquidity}</p>
                <p className="text-gray-500">Verified</p>
                <p className="text-right text-gray-200">{identityFacts.verified}</p>
                <p className="text-gray-500">Honeypot</p>
                <p className="text-right text-gray-200">{identityFacts.honeypot}</p>
                <p className="text-gray-500">Status</p>
                <p className="text-right text-gray-200 uppercase">{status}</p>
              </div>

              <div className="mt-4 border border-[#00f3ff]/15 rounded bg-black/25 p-2 max-h-32 overflow-auto scrollbar-hide">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/70 mb-1">Creator_Risk_History</p>
                <p className="font-mono text-[10px] text-gray-500">NO_DATA_AVAILABLE</p>
              </div>
            </div>

            <p className="mt-2 font-mono text-[10px] text-gray-600">Created: {new Date(createdAtIso).toLocaleString()}</p>
            {error ? <p className="mt-1 text-xs text-[#ff0055]">{error}</p> : null}
          </div>

          <div className="col-span-12 md:col-span-6 row-span-6 flex flex-col gap-4">
            <div className="h-1/3 bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 tech-border-glow relative overflow-hidden">
              <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff]">AI_Forensic_Review</p>
              <p className="mt-3 text-sm text-gray-200 leading-relaxed">
                {forensicReview}
                <span className="inline-block ml-1 h-4 w-2 bg-[#00f3ff]/70 animate-pulse" />
              </p>
            </div>

            <div className="h-2/3 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 p-4 overflow-y-auto scrollbar-hide">
                <div className="mb-3 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[#00f3ff]" />
                  <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff]">Vulnerability_Scan</p>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {auditChecks.map((check) => {
                    const style =
                      check.status === "danger"
                        ? "bg-[#ff0055]/10 border-[#ff0055]/50"
                        : check.status === "warning"
                          ? "bg-[#bc13fe]/10 border-[#bc13fe]/50"
                          : "bg-[#00f3ff]/5 border-[#00f3ff]/30";

                    return (
                      <div key={check.id} className={`relative border p-3 ${style}`}>
                        {check.status === "danger" ? <AlertTriangle className="absolute top-2 right-2 h-3 w-3 text-[#ff0055]" /> : null}
                        <p className="text-xs font-semibold text-gray-100 uppercase tracking-[0.08em]">{check.label}</p>
                        <p className="mt-1 text-xs leading-relaxed text-gray-200">{check.detail}</p>
                        {check.meta ? <p className="mt-1 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-gray-400">{check.meta}</p> : null}
                        <div
                          className={`absolute bottom-0 left-0 h-0.5 w-full ${
                            check.status === "danger"
                              ? "bg-[#ff0055]"
                              : check.status === "warning"
                                ? "bg-[#bc13fe]"
                                : "bg-[#00f3ff]"
                          }`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 flex flex-col">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff]">Distribution_Matrix</p>
                  <p className="text-[10px] font-mono text-gray-500 uppercase tracking-[0.16em]">TOP 5 WALLETS</p>
                </div>

                <div className="scrollbar-hide flex-1 space-y-3 overflow-y-auto">
                  {holderDistribution.available ? (
                    <>
                      {holderDistribution.top5.map((holder) => {
                        const pct = holder.pctOfSupply;
                        const visualPct = pct ?? holder.relativeSharePct ?? 0;
                        const pctText =
                          pct !== null
                            ? `${pct.toFixed(2)}%`
                            : holder.relativeSharePct !== null
                              ? `~${holder.relativeSharePct.toFixed(2)}%*`
                              : "--";
                        const highConcentration = visualPct > 10 && holder.isContract !== true;
                        const barColor = holder.isContract ? "bg-[#00ff94]" : highConcentration ? "bg-[#ff0055]" : "bg-[#0066ff]";

                        return (
                          <div key={holder.address}>
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-gray-300 hover:text-[#00f3ff] transition-colors">
                                {holder.address.slice(0, 8)}...{holder.address.slice(-6)}
                              </p>
                              <p className={`text-xs ${highConcentration ? "text-[#ff0055] font-semibold" : "text-[#00f3ff]"}`}>{pctText}</p>
                            </div>
                            <div className="mt-1 h-1.5 rounded bg-gray-800 overflow-hidden">
                              <div className={`h-full ${barColor}`} style={{ width: `${Math.max(0, Math.min(100, visualPct))}%` }} />
                            </div>
                            {visualPct > 5 && holder.isContract !== true ? (
                              <p className="mt-1 text-[10px] text-[#ff0055]/80 uppercase tracking-[0.14em]">Risk: High Concentration</p>
                            ) : null}
                          </div>
                        );
                      })}

                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/60">
                        Top 5 concentration: {holderDistribution.top5Pct !== null ? `${holderDistribution.top5Pct.toFixed(2)}%` : "--"}
                      </p>
                      {holderDistribution.top5Pct === null ? (
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/45">
                          * relative share among displayed holders
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#ff0055]/75">DATA_UNAVAILABLE</p>
                      <p className="text-xs text-gray-300">
                        {holderDistribution.error
                          ? `Holder provider unavailable: ${holderDistribution.error}`
                          : "Real holder distribution data is not available for this scan."}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="col-span-12 md:col-span-3 row-span-6 relative pointer-events-auto">
            <div className="absolute -top-2 -left-2 h-4 w-4 border-l border-t border-[#00f3ff]/50" />
            <div className="absolute -top-2 -right-2 h-4 w-4 border-r border-t border-[#00f3ff]/50" />
            <div className="absolute -bottom-2 -left-2 h-4 w-4 border-l border-b border-[#00f3ff]/50" />
            <div className="absolute -bottom-2 -right-2 h-4 w-4 border-r border-b border-[#00f3ff]/50" />
            <ReportChat scanId={scanId} />
          </div>
        </div>
      </div>
    </main>
  );
}
