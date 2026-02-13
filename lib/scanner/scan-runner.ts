import { and, eq } from "drizzle-orm";
import { appendScanEvent } from "@/lib/db/scan-events";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import { assessBaseScan, planBaseScan, runEvidenceTool, type EvidenceItem, type PlannedStep } from "@/lib/scanner/agent-scan";

const BASELINE_STEPS: PlannedStep[] = [
  {
    stepKey: "rpc_bytecode",
    toolName: "rpc_getBytecode",
    title: "Fetch bytecode",
    reason: "Required baseline contract existence check",
  },
  {
    stepKey: "rpc_metadata",
    toolName: "rpc_getErc20Metadata",
    title: "Read token metadata",
    reason: "Collect token metadata for context",
  },
  {
    stepKey: "dex_market",
    toolName: "dexscreener_getPairs",
    title: "Fetch DEX market data",
    reason: "Collect liquidity and pool context",
  },
  {
    stepKey: "swap_honeypot",
    toolName: "honeypot_getSimulation",
    title: "Run honeypot swap simulation",
    reason: "Collect deterministic buy/sell tax and sellability evidence",
  },
  {
    stepKey: "lp_lock",
    toolName: "lp_v2_lockStatus",
    title: "Analyze V2 LP lock status",
    reason: "Estimate rug-pull risk from LP burn/ownership",
  },
];

const BASESCAN_STEPS: PlannedStep[] = [
  {
    stepKey: "basescan_verification",
    toolName: "basescan_getSourceInfo",
    title: "Check BaseScan verification",
    reason: "Load source metadata and ABI for contract analysis",
  },
  {
    stepKey: "basescan_creation",
    toolName: "basescan_getContractCreation",
    title: "Fetch contract creation info",
    reason: "Identify creator wallet concentration and LP ownership",
  },
  {
    stepKey: "contract_owner",
    toolName: "contract_ownerStatus",
    title: "Check ownership status",
    reason: "Check if ownership is renounced and who controls admin functions",
  },
  {
    stepKey: "contract_capabilities",
    toolName: "contract_capabilityScan",
    title: "Scan admin capabilities",
    reason: "Detect mint/blacklist/pause/tax-risk capabilities",
  },
];

const HOLDERS_STEP: PlannedStep = {
  stepKey: "holders_distribution",
  toolName: "holders_getTopHolders",
  title: "Fetch holder distribution",
  reason: "Collect top holder concentration metrics",
};

function mergeWithBaseline(plannedSteps: PlannedStep[]) {
  const merged: PlannedStep[] = [];

  const baseline = [
    ...BASELINE_STEPS,
    ...(process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY ? BASESCAN_STEPS : []),
    ...(process.env.BITQUERY_ACCESS_TOKEN ? [HOLDERS_STEP] : []),
  ];

  for (const step of baseline) {
    if (!merged.some((existing) => existing.toolName === step.toolName)) {
      merged.push(step);
    }
  }

  for (const step of plannedSteps) {
    if (!merged.some((existing) => existing.toolName === step.toolName)) {
      merged.push(step);
    }
  }

  return merged;
}

function buildFallbackPlan(): PlannedStep[] {
  return mergeWithBaseline([]);
}

function buildLowConfidenceAssessment(tokenAddress: string, evidenceItems: EvidenceItem[], failureReason: string) {
  const evidenceRefs = evidenceItems.map((item) => item.id);
  const unavailable = evidenceItems.filter((item) => item.status === "unavailable");

  return {
    summary:
      "Assessment completed with low confidence because the AI reasoning phase was unavailable. Evidence was still collected and is listed below.",
    overallScore: 55,
    riskLevel: "medium" as const,
    confidence: "low" as const,
    categoryScores: {
      contractRisk: 50,
      liquidityRisk: 55,
      behaviorRisk: 55,
      distributionRisk: 60,
      honeypotRisk: 60,
    },
    reasons: [
      {
        title: "AI assessment unavailable",
        detail: `Final assessment generation failed (${failureReason}). Falling back to conservative medium-risk output with low confidence.`,
        evidenceRefs,
      },
      {
        title: "Collected evidence may be partial",
        detail: `Collected ${evidenceItems.length} evidence items; ${unavailable.length} were unavailable or errored.`,
        evidenceRefs,
      },
    ],
    missingData: [
      "AI assessment output could not be generated",
      ...(unavailable.length > 0 ? ["Some upstream tool calls were unavailable"] : []),
      `Manual review recommended for token ${tokenAddress.toLowerCase()}`,
    ],
  };
}

export type RunQueuedScanResult =
  | { status: "skipped"; reason: string }
  | { status: "complete" }
  | { status: "failed"; error: string };

export async function runQueuedScan(scanId: string): Promise<RunQueuedScanResult> {
  const existing = await db.query.scans.findFirst({
    where: eq(scans.id, scanId),
  });

  if (!existing) {
    return { status: "skipped", reason: "scan_not_found" };
  }

  if (existing.status === "complete" || existing.status === "failed") {
    return { status: "skipped", reason: `scan_${existing.status}` };
  }

  if (existing.status === "running") {
    return { status: "skipped", reason: "scan_running" };
  }

  const startedAt = new Date();
  const [claimed] = await db
    .update(scans)
    .set({
      status: "running",
      error: null,
      durationMs: null,
      evidence: null,
      score: null,
      narrative: null,
      model: null,
    })
    .where(and(eq(scans.id, scanId), eq(scans.status, "queued")))
    .returning({ id: scans.id, tokenAddress: scans.tokenAddress });

  if (!claimed) {
    return { status: "skipped", reason: "scan_not_queued" };
  }

  await appendScanEvent({
    scanId,
    level: "info",
    type: "run.started",
    message: "Scan started",
    payload: { chain: "base", tokenAddress: claimed.tokenAddress },
  });

  await appendScanEvent({
    scanId,
    level: "info",
    type: "step.started",
    stepKey: "validate_target",
    message: "Validating target contract address",
  });

  await appendScanEvent({
    scanId,
    level: "success",
    type: "step.completed",
    stepKey: "validate_target",
    message: "Target validation complete",
  });

  const evidenceItems: EvidenceItem[] = [];
  let plannedSteps: PlannedStep[] = buildFallbackPlan();
  let plannerModel: string | null = null;
  let currentStepKey = "agent_assessment";
  let hasEmittedStepFailure = false;

  try {
    await appendScanEvent({
      scanId,
      level: "info",
      type: "step.started",
      stepKey: "agent_plan",
      message: "Planning investigation steps",
    });

    await appendScanEvent({
      scanId,
      level: "info",
      type: "log.line",
      message: "Planning investigation steps...",
    });

    try {
      const plan = await planBaseScan(claimed.tokenAddress);
      plannedSteps = mergeWithBaseline(plan.steps);
      plannerModel = plan.model;

      await appendScanEvent({
        scanId,
        level: "info",
        type: "artifact.plan",
        stepKey: "agent_plan",
        message: "Agent plan generated",
        payload: {
          model: plan.model,
          steps: plan.steps,
          fallback: false,
        },
      });

      await appendScanEvent({
        scanId,
        level: "success",
        type: "step.completed",
        stepKey: "agent_plan",
        message: "Planning complete",
      });
    } catch (plannerError) {
      const plannerMessage = plannerError instanceof Error ? plannerError.message : "Planner failed";

      await appendScanEvent({
        scanId,
        level: "warning",
        type: "log.line",
        stepKey: "agent_plan",
        message: `Planner unavailable, using fallback plan: ${plannerMessage}`,
      });

      await appendScanEvent({
        scanId,
        level: "warning",
        type: "artifact.plan",
        stepKey: "agent_plan",
        message: "Using fallback plan",
        payload: {
          model: null,
          steps: plannedSteps,
          fallback: true,
          error: plannerMessage,
        },
      });

      await appendScanEvent({
        scanId,
        level: "warning",
        type: "step.completed",
        stepKey: "agent_plan",
        message: "Planning completed with fallback",
      });
    }

    for (const step of plannedSteps) {
      currentStepKey = step.stepKey;

      await appendScanEvent({
        scanId,
        level: "info",
        type: "step.started",
        stepKey: step.stepKey,
        message: step.title,
        payload: { toolName: step.toolName, reason: step.reason },
      });

      const evidenceItem = await runEvidenceTool(step.toolName, claimed.tokenAddress, {
        evidenceItems,
      });
      evidenceItems.push(evidenceItem);

      await appendScanEvent({
        scanId,
        level: evidenceItem.status === "ok" ? "info" : "warning",
        type: "evidence.item",
        stepKey: step.stepKey,
        message: `${evidenceItem.title}${evidenceItem.error ? ` (${evidenceItem.error})` : ""}`,
        payload: evidenceItem as unknown as Record<string, unknown>,
      });

      await appendScanEvent({
        scanId,
        level: evidenceItem.status === "ok" ? "info" : "warning",
        type: "log.line",
        stepKey: step.stepKey,
        message: `${step.toolName} -> ${evidenceItem.status}`,
        payload: { evidenceId: evidenceItem.id, error: evidenceItem.error },
      });

      const hasCode =
        step.toolName === "rpc_getBytecode" &&
        evidenceItem.status === "ok" &&
        evidenceItem.data.hasCode === false;

      if (hasCode) {
        await appendScanEvent({
          scanId,
          level: "error",
          type: "step.failed",
          stepKey: step.stepKey,
          message: "Address does not contain contract bytecode on Base",
        });
        hasEmittedStepFailure = true;

        throw new Error("Provided address is not a contract on Base");
      }

      await appendScanEvent({
        scanId,
        level: evidenceItem.status === "ok" ? "success" : "warning",
        type: "step.completed",
        stepKey: step.stepKey,
        message: `${step.title} completed`,
      });
    }

    await appendScanEvent({
      scanId,
      level: "info",
      type: "step.started",
      stepKey: "agent_assessment",
      message: "Generating AI assessment from collected evidence",
    });
    currentStepKey = "agent_assessment";

    let assessed: Awaited<ReturnType<typeof assessBaseScan>>["assessment"];
    let assessmentModel: string | null = null;

    try {
      const assessedResult = await assessBaseScan(claimed.tokenAddress, evidenceItems);
      assessed = assessedResult.assessment;
      assessmentModel = assessedResult.model;
    } catch (assessmentError) {
      const assessmentMessage =
        assessmentError instanceof Error ? assessmentError.message : "Assessment generation failed";

      await appendScanEvent({
        scanId,
        level: "warning",
        type: "log.line",
        stepKey: "agent_assessment",
        message: `Assessment fallback engaged: ${assessmentMessage}`,
      });

      assessed = buildLowConfidenceAssessment(claimed.tokenAddress, evidenceItems, assessmentMessage);
      assessmentModel = null;
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const finalEvidence = {
      meta: {
        scanId,
        chain: "base",
        tokenAddress: claimed.tokenAddress,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        scannerVersion: "v2-agent-two-phase",
        scoreVersion: "v2-agent-two-phase",
      },
      items: evidenceItems,
      trace: {
        plan: plannedSteps,
        plannerModel,
      },
    };

    await db
      .update(scans)
      .set({
        status: "complete",
        durationMs,
        evidence: finalEvidence,
        score: assessed,
        narrative: assessed.summary,
        scannerVersion: "v2-agent-two-phase",
        scoreVersion: "v2-agent-two-phase",
        model: assessmentModel,
        error: null,
      })
      .where(eq(scans.id, scanId));

    await appendScanEvent({
      scanId,
      level: "success",
      type: "assessment.final",
      stepKey: "agent_assessment",
      message: "Final risk assessment ready",
      payload: assessed,
    });

    await appendScanEvent({
      scanId,
      level: "success",
      type: "step.completed",
      stepKey: "agent_assessment",
      message: "Agent assessment complete",
    });

    await appendScanEvent({
      scanId,
      level: "success",
      type: "run.completed",
      message: "Scan completed successfully",
      payload: { durationMs },
    });

    return { status: "complete" };
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    const message = error instanceof Error ? error.message : "Scan failed";

    const partialEvidence = {
      meta: {
        scanId,
        chain: "base",
        tokenAddress: claimed.tokenAddress,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs,
        scannerVersion: "v2-agent-two-phase",
        scoreVersion: "v2-agent-two-phase",
      },
      items: evidenceItems,
      trace: {
        partial: true,
        plan: plannedSteps,
        plannerModel,
      },
    };

    if (!hasEmittedStepFailure) {
      await appendScanEvent({
        scanId,
        level: "error",
        type: "step.failed",
        stepKey: currentStepKey,
        message: message,
      });
    }

    await appendScanEvent({
      scanId,
      level: "error",
      type: "run.failed",
      message: "Scan failed",
      payload: { error: message, durationMs },
    });

    await db
      .update(scans)
      .set({
        status: "failed",
        durationMs,
        evidence: partialEvidence,
        error: message,
      })
      .where(eq(scans.id, scanId));

    return { status: "failed", error: message };
  }
}
