import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appendScanEvent } from "@/lib/db/scan-events";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import { assessBaseScan, planBaseScan, runEvidenceTool, type EvidenceItem, type PlannedStep } from "@/lib/scanner/agent-scan";

export const runtime = "nodejs";

function buildFallbackPlan(): PlannedStep[] {
  const steps: PlannedStep[] = [
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
    ...(process.env.BITQUERY_ACCESS_TOKEN
      ? [
          {
            stepKey: "holders_distribution",
            toolName: "holders_getTopHolders",
            title: "Fetch holder distribution",
            reason: "Collect top holder concentration metrics",
          } satisfies PlannedStep,
        ]
      : []),
    {
      stepKey: "dex_market",
      toolName: "dexscreener_getPairs",
      title: "Fetch DEX market data",
      reason: "Collect liquidity and price behavior",
    },
  ];

  if (process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY) {
    steps.splice(2, 0, {
      stepKey: "basescan_verification",
      toolName: "basescan_getSourceInfo",
      title: "Check BaseScan verification",
      reason: "Check source verification status",
    });
  }

  return steps;
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

export async function POST(
  _request: Request,
  context: { params: Promise<{ scanId: string }> },
) {
  const { scanId } = await context.params;
  const parsedScanId = z.string().uuid().safeParse(scanId);

  if (!parsedScanId.success) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const id = parsedScanId.data;
  const existing = await db.query.scans.findFirst({
    where: eq(scans.id, id),
  });

  if (!existing) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  if (existing.status === "complete" || existing.status === "failed") {
    return NextResponse.json({ scanId: id, status: existing.status, skipped: true }, { status: 200 });
  }

  if (existing.status === "running") {
    return NextResponse.json({ scanId: id, status: "running", skipped: true }, { status: 202 });
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
    .where(and(eq(scans.id, id), eq(scans.status, "queued")))
    .returning({ id: scans.id, tokenAddress: scans.tokenAddress });

  if (!claimed) {
    return NextResponse.json({ scanId: id, status: "running", skipped: true }, { status: 202 });
  }

  await appendScanEvent({
    scanId: id,
    level: "info",
    type: "run.started",
    message: "Scan started",
    payload: { chain: "base", tokenAddress: claimed.tokenAddress },
  });

  await appendScanEvent({
    scanId: id,
    level: "info",
    type: "step.started",
    stepKey: "validate_target",
    message: "Validating target contract address",
  });

  await appendScanEvent({
    scanId: id,
    level: "success",
    type: "step.completed",
    stepKey: "validate_target",
    message: "Target validation complete",
  });

  const evidenceItems: EvidenceItem[] = [];
  let plannedSteps: PlannedStep[] = buildFallbackPlan();
  let plannerModel: string | null = null;
  let currentStepKey: string = "agent_assessment";
  let hasEmittedStepFailure = false;

  try {
    await appendScanEvent({
      scanId: id,
      level: "info",
      type: "step.started",
      stepKey: "agent_plan",
      message: "Planning investigation steps",
    });

    await appendScanEvent({
      scanId: id,
      level: "info",
      type: "log.line",
      message: "Planning investigation steps...",
    });

    try {
      const plan = await planBaseScan(claimed.tokenAddress);
      plannedSteps = plan.steps;
      plannerModel = plan.model;

      await appendScanEvent({
        scanId: id,
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
        scanId: id,
        level: "success",
        type: "step.completed",
        stepKey: "agent_plan",
        message: "Planning complete",
      });
    } catch (plannerError) {
      const plannerMessage = plannerError instanceof Error ? plannerError.message : "Planner failed";

      await appendScanEvent({
        scanId: id,
        level: "warning",
        type: "log.line",
        stepKey: "agent_plan",
        message: `Planner unavailable, using fallback plan: ${plannerMessage}`,
      });

      await appendScanEvent({
        scanId: id,
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
        scanId: id,
        level: "warning",
        type: "step.completed",
        stepKey: "agent_plan",
        message: "Planning completed with fallback",
      });
    }

    for (const step of plannedSteps) {
      currentStepKey = step.stepKey;

      await appendScanEvent({
        scanId: id,
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
        scanId: id,
        level: evidenceItem.status === "ok" ? "info" : "warning",
        type: "evidence.item",
        stepKey: step.stepKey,
        message: `${evidenceItem.title}${evidenceItem.error ? ` (${evidenceItem.error})` : ""}`,
        payload: evidenceItem as unknown as Record<string, unknown>,
      });

      await appendScanEvent({
        scanId: id,
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
          scanId: id,
          level: "error",
          type: "step.failed",
          stepKey: step.stepKey,
          message: "Address does not contain contract bytecode on Base",
        });
        hasEmittedStepFailure = true;

        throw new Error("Provided address is not a contract on Base");
      }

      await appendScanEvent({
        scanId: id,
        level: evidenceItem.status === "ok" ? "success" : "warning",
        type: "step.completed",
        stepKey: step.stepKey,
        message: `${step.title} completed`,
      });
    }

    await appendScanEvent({
      scanId: id,
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
        scanId: id,
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
        scanId: id,
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
      .where(eq(scans.id, id));

    await appendScanEvent({
      scanId: id,
      level: "success",
      type: "assessment.final",
      stepKey: "agent_assessment",
      message: "Final risk assessment ready",
      payload: assessed,
    });

    await appendScanEvent({
      scanId: id,
      level: "success",
      type: "step.completed",
      stepKey: "agent_assessment",
      message: "Agent assessment complete",
    });

    await appendScanEvent({
      scanId: id,
      level: "success",
      type: "run.completed",
      message: "Scan completed successfully",
      payload: { durationMs },
    });

    return NextResponse.json({ scanId: id, status: "complete" }, { status: 200 });
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    const message = error instanceof Error ? error.message : "Scan failed";

    const partialEvidence = {
      meta: {
        scanId: id,
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
        scanId: id,
        level: "error",
        type: "step.failed",
        stepKey: currentStepKey,
        message: message,
      });
    }

    await appendScanEvent({
      scanId: id,
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
      .where(eq(scans.id, id));

    return NextResponse.json({ scanId: id, status: "failed" }, { status: 500 });
  }
}
