"use client";

import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Sector, Tooltip } from "recharts";
import { AddressGraph } from "@/components/scan/address-graph";
import { HudHeader } from "@/components/scan/hud-header";
import { TimelineSheet } from "@/components/scan/timeline-sheet";
import { ReportChat } from "@/components/scan/report-chat";
import { buildAddressGraphData } from "@/lib/graph/address-graph";

type ScoreReason = {
  title: string;
  detail: string;
  evidenceRefs: string[];
};

type AgentScore = {
  overallScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  categoryScores?: {
    contractRisk: number;
    liquidityRisk: number;
    behaviorRisk: number;
    distributionRisk: number;
    honeypotRisk: number;
  };
  reasons: ScoreReason[];
  missingData: string[];
};

type EvidenceItem = {
  id: string;
  tool: string;
  title: string;
  sourceUrl?: string | null;
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

type SectionStatus = "safe" | "warning" | "danger" | "unknown";

type ScamSection = {
  id: string;
  title: string;
  status: SectionStatus;
  sourceUrl: string | null;
  rows: Array<{ label: string; value: string }>;
  note?: string;
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
      top10Pct: null as number | null,
      method: null as string | null,
      amountSemantics: null as string | null,
      supplyPctAvailable: false,
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
    top10Pct: typeof holderEvidence.data?.top10Pct === "number" ? holderEvidence.data.top10Pct : null,
    method: typeof holderEvidence.data?.method === "string" ? holderEvidence.data.method : null,
    amountSemantics: typeof holderEvidence.data?.amountSemantics === "string" ? holderEvidence.data.amountSemantics : null,
    supplyPctAvailable: holderEvidence.data?.supplyPctAvailable === true,
    asOfDate: typeof holderEvidence.data?.asOfDate === "string" ? holderEvidence.data.asOfDate : null,
  };
}

function getDistributionCaption(holderDistribution: ReturnType<typeof getHolderDistribution>) {
  if (!holderDistribution.available) {
    return null;
  }

  const topWalletPct = holderDistribution.top5[0]?.pctOfSupply ?? null;
  const top5Pct = holderDistribution.top5Pct;
  const top10Pct = holderDistribution.top10Pct;
  const contractCount = holderDistribution.top5.filter((holder) => holder.isContract === true).length;

  if (topWalletPct !== null && topWalletPct >= 20) {
    return "Whale-heavy pattern: a single wallet holds a large share of supply.";
  }

  if (top10Pct !== null && top10Pct >= 70) {
    return "Concentrated holder pattern: top wallets can move price quickly on large sells.";
  }

  if (contractCount >= 3) {
    return "Contract-heavy distribution: a notable share sits in contract wallets (pool/treasury/router).";
  }

  if (top5Pct !== null && top5Pct <= 25) {
    return "Broad distribution: no strong concentration signal among the largest tracked wallets.";
  }

  if (top5Pct !== null && top5Pct <= 45) {
    return "Mixed distribution: moderate concentration; monitor major wallet movements.";
  }

  if (top5Pct === null) {
    return holderDistribution.method === "balance_updates"
      ? "Approximate distribution: fallback mode uses USD-weighted ranking, not token supply percentages."
      : "Approximate distribution: percentages are relative to visible holders only.";
  }

  return "Concentrated distribution: a small wallet set controls a significant share.";
}

function getIdentityFacts(items: EvidenceItem[]) {
  const dex = items.find((item) => item.tool === "dexscreener_getPairs");
  const verify = items.find((item) => item.tool === "basescan_getSourceInfo");
  const honeypot = items.find((item) => item.tool === "honeypot_getSimulation");

  const bestPair = (dex?.data?.bestPair as { liquidityUsd?: number | null } | undefined) ?? undefined;
  const liquidity = typeof bestPair?.liquidityUsd === "number" ? `$${Math.round(bestPair.liquidityUsd).toLocaleString()}` : "UNKNOWN";
  const verifiedRaw = verify?.data?.isVerified;
  const verified = verifiedRaw === true ? "YES" : verifiedRaw === false ? "NO" : "UNKNOWN";
  const sellableRaw = honeypot?.data?.sellable;
  const honeypotResult =
    sellableRaw === true ? "NO (SELLABLE)" : sellableRaw === false ? "YES" : honeypot?.status === "unavailable" ? "DATA_UNAVAILABLE" : "UNKNOWN";

  return {
    marketCap: "UNKNOWN",
    liquidity,
    verified,
    honeypot: honeypotResult,
  };
}

function getAuditChecks(agentScore: AgentScore | null, holderDistribution: ReturnType<typeof getHolderDistribution>, items: EvidenceItem[]): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const bytecode = items.find((item) => item.tool === "rpc_getBytecode");
  const metadata = items.find((item) => item.tool === "rpc_getErc20Metadata");
  const verify = items.find((item) => item.tool === "basescan_getSourceInfo");
  const dex = items.find((item) => item.tool === "dexscreener_getPairs");
  const holders = items.find((item) => item.tool === "holders_getTopHolders");
  const honeypot = items.find((item) => item.tool === "honeypot_getSimulation");
  const ownerStatus = items.find((item) => item.tool === "contract_ownerStatus");
  const capabilityScan = items.find((item) => item.tool === "contract_capabilityScan");
  const creation = items.find((item) => item.tool === "basescan_getContractCreation");
  const lpLock = items.find((item) => item.tool === "lp_v2_lockStatus");

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
          : holderDistribution.method === "balance_updates"
            ? "Supply-based concentration unavailable (USD-weighted fallback mode)"
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

  const simulationSuccess = honeypot?.data?.simulationSuccess === true;
  const sellable = honeypot?.data?.sellable;
  const buyTax = typeof honeypot?.data?.buyTax === "number" ? honeypot.data.buyTax : null;
  const sellTax = typeof honeypot?.data?.sellTax === "number" ? honeypot.data.sellTax : null;

  checks.push({
    id: "swap-analysis",
    label: "Swap Analysis (honeypot.is)",
    status:
      honeypot?.status === "unavailable"
        ? "warning"
        : simulationSuccess && sellable === true
          ? "safe"
          : simulationSuccess && sellable === false
            ? "danger"
            : "warning",
    detail:
      honeypot?.status === "unavailable"
        ? "Swap simulation data unavailable"
        : simulationSuccess && sellable === true
          ? "Token is sellable (not a honeypot) at this time"
          : simulationSuccess && sellable === false
            ? "Token appears non-sellable / honeypot-like"
            : "Simulation did not return a conclusive result",
    meta:
      buyTax !== null && sellTax !== null
        ? `Buy fee: ${buyTax.toFixed(2)}% | Sell fee: ${sellTax.toFixed(2)}%`
        : honeypot?.error ?? "Fees unavailable",
  });

  const ownerAddress = typeof ownerStatus?.data?.ownerAddress === "string" ? ownerStatus.data.ownerAddress : null;
  const renounced = ownerStatus?.data?.renounced;
  checks.push({
    id: "ownership",
    label: "Contract Ownership",
    status: renounced === true ? "safe" : renounced === false ? "warning" : "warning",
    detail:
      renounced === true
        ? "Ownership renounced"
        : renounced === false
          ? "Ownership not renounced; owner can potentially modify behavior"
          : "Ownership status unavailable",
    meta: ownerAddress ?? ownerStatus?.error ?? undefined,
  });

  const mintPossible = capabilityScan?.data?.mintPossible === true;
  const canSetFees = capabilityScan?.data?.canSetFees === true;
  const canPause = capabilityScan?.data?.canPause === true;
  const canBlacklist = capabilityScan?.data?.canBlacklist === true;
  const capabilityFlags = [
    mintPossible ? "mint" : null,
    canSetFees ? "fee/tax changes" : null,
    canPause ? "pause" : null,
    canBlacklist ? "blacklist" : null,
  ].filter((entry): entry is string => Boolean(entry));

  checks.push({
    id: "capabilities",
    label: "Contract Capability Scan",
    status: capabilityFlags.length > 0 ? "danger" : "safe",
    detail:
      capabilityFlags.length > 0
        ? "Admin-sensitive functions detected in ABI"
        : "No high-risk admin functions detected in ABI",
    meta: capabilityFlags.length > 0 ? capabilityFlags.join(", ") : undefined,
  });

  const deployerAddress = typeof creation?.data?.deployerAddress === "string" ? creation.data.deployerAddress : null;
  const deployerHolder = deployerAddress
    ? holderDistribution.top5.find((holder) => holder.address.toLowerCase() === deployerAddress.toLowerCase())
    : null;
  const ownerHolder = ownerAddress
    ? holderDistribution.top5.find((holder) => holder.address.toLowerCase() === ownerAddress.toLowerCase())
    : null;
  const deployerPct = deployerHolder?.pctOfSupply ?? null;
  const ownerPct = ownerHolder?.pctOfSupply ?? null;

  checks.push({
    id: "owner-creator-balance",
    label: "Owner / Creator Holder Share",
    status:
      (typeof ownerPct === "number" && ownerPct >= 5) || (typeof deployerPct === "number" && deployerPct >= 5)
        ? "danger"
        : "safe",
    detail: "Estimated share from top holders snapshot",
    meta: `Owner: ${ownerPct !== null ? `${ownerPct.toFixed(2)}%` : "unknown"} | Creator: ${deployerPct !== null ? `${deployerPct.toFixed(2)}%` : "unknown"}`,
  });

  const top10Pct = holderDistribution.top10Pct ?? null;
  checks.push({
    id: "top10",
    label: "Top 10 Holder Concentration",
    status: top10Pct === null ? "warning" : top10Pct >= 70 ? "danger" : "safe",
    detail:
      top10Pct === null
        ? "Top 10 concentration unavailable"
        : `Top 10 holders control ${top10Pct.toFixed(2)}% of tracked supply`,
    meta: holderDistribution.method === "balance_updates" ? "Method: USD-weighted fallback" : undefined,
  });

  const lpBurnedPct = typeof lpLock?.data?.computed === "object" && lpLock?.data?.computed
    ? (() => {
        const computed = lpLock.data.computed as { burnedPct?: unknown };
        return typeof computed.burnedPct === "number" ? computed.burnedPct : null;
      })()
    : null;
  const lpStatusRaw = lpLock?.data?.lockStatus;
  checks.push({
    id: "liquidity-lock",
    label: "Liquidity Analysis (V2 LP)",
    status: lpStatusRaw === "locked" ? "safe" : lpStatusRaw === "unlocked" ? "danger" : "warning",
    detail:
      lpStatusRaw === "locked"
        ? "Largest V2 LP appears burned/locked"
        : lpStatusRaw === "unlocked"
          ? "Largest V2 LP appears withdrawable"
          : "Largest V2 LP lock status unknown",
    meta: lpBurnedPct !== null ? `Burned LP: ${lpBurnedPct.toFixed(2)}%` : undefined,
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

function findCheck(auditChecks: AuditCheck[], id: string) {
  return auditChecks.find((check) => check.id === id);
}

function toSectionStatus(check?: AuditCheck): SectionStatus {
  if (!check) {
    return "unknown";
  }
  return check.status;
}

function getScamSections(
  auditChecks: AuditCheck[],
  holderDistribution: ReturnType<typeof getHolderDistribution>,
  items: EvidenceItem[],
  distributionCaption: string | null,
): ScamSection[] {
  const honeypot = items.find((item) => item.tool === "honeypot_getSimulation");
  const sourceInfo = items.find((item) => item.tool === "basescan_getSourceInfo");
  const ownerStatus = items.find((item) => item.tool === "contract_ownerStatus");
  const creation = items.find((item) => item.tool === "basescan_getContractCreation");
  const lpLock = items.find((item) => item.tool === "lp_v2_lockStatus");

  const swapCheck = findCheck(auditChecks, "swap-analysis");
  const ownershipCheck = findCheck(auditChecks, "ownership");
  const capabilityCheck = findCheck(auditChecks, "capabilities");
  const holderCheck = findCheck(auditChecks, "top10");
  const ownerCreatorCheck = findCheck(auditChecks, "owner-creator-balance");
  const lpCheck = findCheck(auditChecks, "liquidity-lock");
  const marketCheck = findCheck(auditChecks, "market");

  const buyTax = typeof honeypot?.data?.buyTax === "number" ? honeypot.data.buyTax : null;
  const sellTax = typeof honeypot?.data?.sellTax === "number" ? honeypot.data.sellTax : null;
  const sellable = honeypot?.data?.sellable;
  const simulationSuccess = honeypot?.data?.simulationSuccess === true;

  const ownerAddress = typeof ownerStatus?.data?.ownerAddress === "string" ? ownerStatus.data.ownerAddress : null;
  const renounced = ownerStatus?.data?.renounced;
  const deployerAddress = typeof creation?.data?.deployerAddress === "string" ? creation.data.deployerAddress : null;

  const top10Text = holderDistribution.top10Pct !== null ? `${holderDistribution.top10Pct.toFixed(2)}%` : "unknown";
  const top5Text = holderDistribution.top5Pct !== null ? `${holderDistribution.top5Pct.toFixed(2)}%` : "unknown";

  const lpBurnedPct =
    typeof lpLock?.data?.computed === "object" && lpLock?.data?.computed
      ? (() => {
          const computed = lpLock.data.computed as { burnedPct?: unknown };
          return typeof computed.burnedPct === "number" ? computed.burnedPct : null;
        })()
      : null;
  const lpStatus = typeof lpLock?.data?.lockStatus === "string" ? lpLock.data.lockStatus : "unknown";

  return [
    {
      id: "swap",
      title: "Swap Analysis",
      status: toSectionStatus(swapCheck),
      sourceUrl: honeypot?.sourceUrl ?? null,
      rows: [
        { label: "Sellability", value: simulationSuccess ? (sellable === true ? "SELLABLE" : sellable === false ? "BLOCKED" : "UNKNOWN") : "UNKNOWN" },
        { label: "Buy Fee", value: buyTax !== null ? `${buyTax.toFixed(2)}%` : "UNKNOWN" },
        { label: "Sell Fee", value: sellTax !== null ? `${sellTax.toFixed(2)}%` : "UNKNOWN" },
      ],
      note: swapCheck?.detail,
    },
    {
      id: "contract",
      title: "Contract Analysis",
      status: capabilityCheck?.status === "danger" ? "danger" : toSectionStatus(ownershipCheck),
      sourceUrl: sourceInfo?.sourceUrl ?? null,
      rows: [
        {
          label: "Verified Source",
          value: sourceInfo?.data?.isVerified === true ? "YES" : sourceInfo?.data?.isVerified === false ? "NO" : "UNKNOWN",
        },
        {
          label: "Ownership",
          value: renounced === true ? "RENOUNCED" : renounced === false ? "NOT RENOUNCED" : "UNKNOWN",
        },
        {
          label: "Owner Wallet",
          value: ownerAddress ? `${ownerAddress.slice(0, 8)}...${ownerAddress.slice(-6)}` : "UNKNOWN",
        },
        {
          label: "Admin Risk Flags",
          value: capabilityCheck?.meta ? capabilityCheck.meta.toUpperCase() : "NONE DETECTED",
        },
      ],
      note: ownershipCheck?.detail,
    },
    {
      id: "holders",
      title: "Holder Analysis",
      status: ownerCreatorCheck?.status === "danger" || holderCheck?.status === "danger" ? "danger" : toSectionStatus(holderCheck),
      sourceUrl: items.find((item) => item.tool === "holders_getTopHolders")?.sourceUrl ?? null,
      rows: [
        { label: "Creator Wallet", value: deployerAddress ? `${deployerAddress.slice(0, 8)}...${deployerAddress.slice(-6)}` : "UNKNOWN" },
        { label: "Top 5 Concentration", value: top5Text },
        { label: "Top 10 Concentration", value: top10Text },
        {
          label: "Method",
          value:
            holderDistribution.method === "balance_updates"
              ? "USD-FALLBACK"
              : holderDistribution.method === "token_holders"
                ? "TOKEN-HOLDERS"
                : "UNKNOWN",
        },
        {
          label: "Supply Pct",
          value: holderDistribution.supplyPctAvailable ? "AVAILABLE" : "UNAVAILABLE",
        },
      ],
      note: distributionCaption ?? holderCheck?.detail,
    },
    {
      id: "liquidity",
      title: "Liquidity Analysis",
      status: toSectionStatus(lpCheck),
      sourceUrl: items.find((item) => item.tool === "dexscreener_getPairs")?.sourceUrl ?? null,
      rows: [
        {
          label: "LP Lock Status",
          value:
            lpStatus === "locked"
              ? "LOCKED/BURNED"
              : lpStatus === "unlocked"
                ? "UNLOCKED"
                : "UNKNOWN",
        },
        { label: "Burned LP", value: lpBurnedPct !== null ? `${lpBurnedPct.toFixed(2)}%` : "UNKNOWN" },
        { label: "Market Signal", value: marketCheck?.detail?.toUpperCase() ?? "UNKNOWN" },
      ],
      note: lpCheck?.detail,
    },
  ];
}

function getRiskCompositionData(agentScore: AgentScore | null) {
  if (!agentScore?.categoryScores) {
    return [] as Array<{ name: string; value: number; color: string }>;
  }

  const { contractRisk, liquidityRisk, behaviorRisk, distributionRisk, honeypotRisk } = agentScore.categoryScores;
  return [
    { name: "Contract", value: Math.max(0, contractRisk), color: "#ff0055" },
    { name: "Liquidity", value: Math.max(0, liquidityRisk), color: "#ff9f43" },
    { name: "Behavior", value: Math.max(0, behaviorRisk), color: "#bc13fe" },
    { name: "Distribution", value: Math.max(0, distributionRisk), color: "#00f3ff" },
    { name: "Honeypot", value: Math.max(0, honeypotRisk), color: "#00ff94" },
  ];
}

function parseActiveSectorProps(props: unknown) {
  if (!props || typeof props !== "object") {
    return null;
  }

  const candidate = props as Record<string, unknown>;
  if (
    typeof candidate.cx !== "number" ||
    typeof candidate.cy !== "number" ||
    typeof candidate.innerRadius !== "number" ||
    typeof candidate.outerRadius !== "number" ||
    typeof candidate.startAngle !== "number" ||
    typeof candidate.endAngle !== "number" ||
    typeof candidate.fill !== "string"
  ) {
    return null;
  }

  return {
    cx: candidate.cx,
    cy: candidate.cy,
    innerRadius: candidate.innerRadius,
    outerRadius: candidate.outerRadius,
    startAngle: candidate.startAngle,
    endAngle: candidate.endAngle,
    fill: candidate.fill,
  };
}

export function ReportView({ scanId, tokenAddress, status, createdAtIso, narrative, score, evidence, error }: ReportViewProps) {
  const [hudVisible, setHudVisible] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [activeRiskSlice, setActiveRiskSlice] = useState<number | null>(null);

  const agentScore = useMemo(() => (isAgentScore(score) ? score : null), [score]);
  const evidenceItems = useMemo(() => getEvidenceItems(evidence), [evidence]);
  const holderDistribution = useMemo(() => getHolderDistribution(evidenceItems), [evidenceItems]);
  const distributionCaption = useMemo(() => getDistributionCaption(holderDistribution), [holderDistribution]);
  const identityFacts = useMemo(() => getIdentityFacts(evidenceItems), [evidenceItems]);
  const auditChecks = useMemo(() => getAuditChecks(agentScore, holderDistribution, evidenceItems), [agentScore, holderDistribution, evidenceItems]);
  const scamSections = useMemo(
    () => getScamSections(auditChecks, holderDistribution, evidenceItems, distributionCaption),
    [auditChecks, holderDistribution, evidenceItems, distributionCaption],
  );
  const riskCompositionData = useMemo(() => getRiskCompositionData(agentScore), [agentScore]);
  const addressGraphData = useMemo(() => buildAddressGraphData(tokenAddress, evidenceItems), [tokenAddress, evidenceItems]);
  const activeRiskData =
    activeRiskSlice !== null && activeRiskSlice >= 0 && activeRiskSlice < riskCompositionData.length
      ? riskCompositionData[activeRiskSlice]
      : null;

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
          <div className="absolute inset-0">
            <AddressGraph data={addressGraphData} className="h-full w-full" />
          </div>
        </div>

        {hudVisible ? <div className="absolute inset-0 bg-[#030014]/40 backdrop-blur-sm transition-all duration-700" /> : null}

        <div
          className={`col-span-12 row-span-6 grid grid-cols-12 grid-rows-6 gap-4 pointer-events-auto transition-all duration-500 transform ${
            hudVisible ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"
          }`}
        >
          <div className="col-span-12 md:col-span-9 row-span-6 flex flex-col gap-4">
            <div className="h-1/3 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="h-full bg-[#030014]/60 backdrop-blur-md border border-[#ff0055]/30 rounded-lg p-4 clip-corner-bl tech-border-glow relative overflow-hidden">
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

              <div className="h-full bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 clip-notch tech-border-glow relative overflow-hidden">
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
                </div>

                <p className="mt-3 font-mono text-[10px] text-gray-600">Created: {new Date(createdAtIso).toLocaleString()}</p>
                {error ? <p className="mt-1 text-xs text-[#ff0055]">{error}</p> : null}
              </div>

              <div className="h-full bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 tech-border-glow relative overflow-hidden overflow-y-auto scrollbar-hide">
                <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff]">AI_Forensic_Review</p>
                <p className="mt-3 text-sm text-gray-200 leading-relaxed">
                  {forensicReview}
                  <span className="inline-block ml-1 h-4 w-2 bg-[#00f3ff]/70 animate-pulse" />
                </p>
              </div>
            </div>

            <div className="h-2/3 grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 tech-border-glow overflow-y-auto scrollbar-hide">
                <div className="mb-4 flex flex-col items-center gap-3">
                  <div className="flex items-center justify-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-[#00f3ff]" />
                    <p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#00f3ff]">Scam_Analysis</p>
                  </div>
                  <div className="relative h-56 w-56 shrink-0">
                    {riskCompositionData.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={riskCompositionData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={62}
                              outerRadius={102}
                              paddingAngle={2}
                              stroke="none"
                              activeIndex={activeRiskSlice ?? undefined}
                              activeShape={(props: unknown) => {
                                const sector = parseActiveSectorProps(props);
                                if (!sector) {
                                  return <></>;
                                }

                                return (
                                  <Sector
                                    cx={sector.cx}
                                    cy={sector.cy}
                                    innerRadius={sector.innerRadius}
                                    outerRadius={sector.outerRadius + 10}
                                    startAngle={sector.startAngle}
                                    endAngle={sector.endAngle}
                                    fill={sector.fill}
                                  />
                                );
                              }}
                              onMouseEnter={(_data, index) => setActiveRiskSlice(index)}
                              onMouseLeave={() => setActiveRiskSlice(null)}
                            >
                              {riskCompositionData.map((slice) => (
                                <Cell key={slice.name} fill={slice.color} />
                              ))}
                            </Pie>
                            <Tooltip
                              formatter={(value: number, _name: string, entry: { payload?: { name?: string } }) => {
                                const label = entry?.payload?.name ?? "Risk";
                                return [`${value.toFixed(1)} / 100`, label];
                              }}
                              contentStyle={{
                                background: "rgba(3, 0, 20, 0.96)",
                                border: "1px solid rgba(0, 243, 255, 0.4)",
                                borderRadius: "8px",
                                color: "#d1d5db",
                                fontFamily: "JetBrains Mono, monospace",
                                fontSize: "11px",
                                padding: "8px 10px",
                              }}
                              labelStyle={{ color: "#00f3ff", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em" }}
                              itemStyle={{ color: "#e5e7eb", fontSize: "11px" }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <div className="text-center">
                            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/75">
                              {activeRiskData ? activeRiskData.name : "Risk Mix"}
                            </p>
                            <p className="font-mono text-lg leading-none text-[#00f3ff]/90">
                              {activeRiskData ? `${activeRiskData.value.toFixed(1)}` : `${agentScore?.overallScore ?? "--"}`}
                            </p>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-full border border-[#00f3ff]/20 text-[10px] font-mono uppercase tracking-[0.12em] text-[#00f3ff]/50">
                        no data
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {scamSections.map((section) => {
                    const sectionStyle =
                      section.status === "danger"
                        ? "border-[#ff0055]/45 bg-[#ff0055]/8"
                        : section.status === "warning"
                          ? "border-[#ff9f43]/45 bg-[#ff9f43]/8"
                          : section.status === "safe"
                            ? "border-[#00f3ff]/30 bg-[#00f3ff]/5"
                            : "border-[#6b7280]/40 bg-[#6b7280]/8";

                    const pillStyle =
                      section.status === "danger"
                        ? "text-[#ff0055] border-[#ff0055]/50"
                        : section.status === "warning"
                          ? "text-[#ff9f43] border-[#ff9f43]/50"
                          : section.status === "safe"
                            ? "text-[#00f3ff] border-[#00f3ff]/40"
                            : "text-gray-400 border-gray-500/40";

                    return (
                      <div key={section.id} className={`rounded-md border p-3 ${sectionStyle}`}>
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-100">{section.title}</p>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.12em] border ${pillStyle}`}>
                            {section.status}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          {section.rows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-2">
                              <p className="text-[11px] text-gray-400">{row.label}</p>
                              <p className="text-[11px] font-mono text-right text-gray-200">{row.value}</p>
                            </div>
                          ))}
                        </div>

                        {section.note ? <p className="mt-2 text-[10px] leading-relaxed text-gray-300/80">{section.note}</p> : null}
                        {section.sourceUrl ? (
                          <a
                            href={section.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/60 hover:text-[#00f3ff]"
                          >
                            Source
                          </a>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="lg:col-span-1 bg-[#030014]/60 backdrop-blur-md border border-[#00f3ff]/20 rounded-lg p-4 flex flex-col">
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
                      {distributionCaption ? (
                        <p className="text-[10px] leading-relaxed text-gray-300/80">{distributionCaption}</p>
                      ) : null}
                      {holderDistribution.top5Pct === null ? (
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/45">
                          {holderDistribution.method === "balance_updates"
                            ? "* USD-weighted fallback (not token-supply percentages)"
                            : "* relative share among displayed holders"}
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
