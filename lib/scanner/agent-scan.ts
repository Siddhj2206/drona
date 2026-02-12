import { generateText, Output } from "ai";
import { createCerebras } from "@ai-sdk/cerebras";
import { z } from "zod";
import { getBytecode, getErc20Metadata } from "@/lib/chains/evm/base-rpc";
import { getBaseContractVerification } from "@/lib/chains/evm/basescan";
import { getDexPairsForBaseToken } from "@/lib/chains/evm/dexscreener";

const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);

const assessmentSchema = z.object({
  summary: z.string(),
  overallScore: z.number().min(0).max(100),
  riskLevel: riskLevelSchema,
  confidence: confidenceSchema,
  categoryScores: z.object({
    contractRisk: z.number().min(0).max(100),
    liquidityRisk: z.number().min(0).max(100),
    behaviorRisk: z.number().min(0).max(100),
    distributionRisk: z.number().min(0).max(100),
    honeypotRisk: z.number().min(0).max(100),
  }),
  reasons: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      evidenceRefs: z.array(z.string()),
    }),
  ),
  missingData: z.array(z.string()),
});

const plannerStepSchema = z.object({
  toolName: z.enum([
    "rpc_getBytecode",
    "rpc_getErc20Metadata",
    "basescan_getSourceInfo",
    "dexscreener_getPairs",
  ]),
  reason: z.string(),
});

const plannerSchema = z.object({
  steps: z.array(plannerStepSchema),
});

type ToolName = z.infer<typeof plannerStepSchema>["toolName"];

type EvidenceItem = {
  id: string;
  tool: ToolName;
  title: string;
  sourceUrl: string | null;
  fetchedAt: string;
  status: "ok" | "unavailable";
  data: Record<string, unknown>;
  error: string | null;
};

type PlannedStep = {
  stepKey: string;
  toolName: ToolName;
  title: string;
  reason: string;
};

const TOOL_METADATA: Record<ToolName, { stepKey: string; title: string }> = {
  rpc_getBytecode: {
    stepKey: "rpc_bytecode",
    title: "Fetch bytecode",
  },
  rpc_getErc20Metadata: {
    stepKey: "rpc_metadata",
    title: "Read token metadata",
  },
  basescan_getSourceInfo: {
    stepKey: "basescan_verification",
    title: "Check BaseScan verification",
  },
  dexscreener_getPairs: {
    stepKey: "dex_market",
    title: "Fetch DEX market data",
  },
};

const REQUIRED_TOOLS: ToolName[] = ["rpc_getBytecode", "rpc_getErc20Metadata", "dexscreener_getPairs"];

function getModelId() {
  return process.env.CEREBRAS_MODEL ?? "llama-3.3-70b";
}

const FALLBACK_MODEL_ID = "llama-3.3-70b";

function getProvider() {
  const apiKey = process.env.CEREBRAS_API_KEY;

  if (!apiKey) {
    throw new Error("CEREBRAS_API_KEY is not set");
  }

  return createCerebras({ apiKey });
}

function buildEvidenceId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function toTimestamp() {
  return new Date().toISOString();
}

function normalizePlannerSteps(rawSteps: z.infer<typeof plannerStepSchema>[]) {
  const availableTools = new Set<ToolName>([
    "rpc_getBytecode",
    "rpc_getErc20Metadata",
    "dexscreener_getPairs",
    ...(process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY
      ? (["basescan_getSourceInfo"] as ToolName[])
      : []),
  ]);

  const deduped: ToolName[] = [];

  for (const step of rawSteps) {
    if (!availableTools.has(step.toolName)) {
      continue;
    }

    if (!deduped.includes(step.toolName)) {
      deduped.push(step.toolName);
    }
  }

  for (const requiredTool of REQUIRED_TOOLS) {
    if (!deduped.includes(requiredTool)) {
      deduped.unshift(requiredTool);
    }
  }

  const finalTools: ToolName[] = [];
  for (const toolName of deduped) {
    if (availableTools.has(toolName) && !finalTools.includes(toolName)) {
      finalTools.push(toolName);
    }
  }

  return finalTools.map((toolName) => {
    const raw = rawSteps.find((step) => step.toolName === toolName);
    const meta = TOOL_METADATA[toolName];
    return {
      stepKey: meta.stepKey,
      toolName,
      title: meta.title,
      reason: raw?.reason?.trim() || `Collect evidence using ${toolName}`,
    } satisfies PlannedStep;
  });
}

function assertReasonCitations(
  reasons: z.infer<typeof assessmentSchema>["reasons"],
  evidenceItems: EvidenceItem[],
) {
  if (reasons.length === 0) {
    throw new Error("Assessment must include at least one reason");
  }

  const ids = new Set(evidenceItems.map((item) => item.id));

  for (const reason of reasons) {
    if (reason.title.trim().length === 0 || reason.detail.trim().length === 0) {
      throw new Error("Assessment reasons must have non-empty title and detail");
    }

    if (reason.evidenceRefs.length === 0) {
      throw new Error("Assessment reasons must include at least one evidence reference");
    }

    for (const ref of reason.evidenceRefs) {
      if (!ids.has(ref)) {
        throw new Error(`Assessment referenced unknown evidence id: ${ref}`);
      }
    }
  }
}

export async function planBaseScan(tokenAddress: string) {
  const cerebras = getProvider();
  const modelId = getModelId();
  const hasBaseScan = Boolean(process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY);

  const runPlan = async (candidateModel: string) =>
    generateText({
      model: cerebras(candidateModel),
      temperature: 0,
      system:
        "You are Drona planner. Produce a concise investigation tool plan for a Base token risk scan. Use only allowed tools. No explanations outside JSON.",
      prompt: `Token address: ${tokenAddress}\nAllowed tools: rpc_getBytecode, rpc_getErc20Metadata, dexscreener_getPairs${hasBaseScan ? ", basescan_getSourceInfo" : ""}.\nBaseScan tool availability: ${hasBaseScan ? "available" : "unavailable"}.\nReturn ordered steps from most essential to optional.`,
      output: Output.object({
        schema: plannerSchema,
        name: "drona_plan",
        description: "Ordered tool plan for token scan",
      }),
      providerOptions: {
        cerebras: {
          strictJsonSchema: false,
        },
      },
      maxOutputTokens: 600,
    });

  let result;
  try {
    result = await runPlan(modelId);
  } catch (error) {
    const shouldRetry = modelId !== FALLBACK_MODEL_ID && error instanceof Error && error.message.includes("No output generated");

    if (!shouldRetry) {
      throw error;
    }

    result = await runPlan(FALLBACK_MODEL_ID);
  }

  const parsed = plannerSchema.parse(result.output);
  const steps = normalizePlannerSteps(parsed.steps);

  return {
    steps,
    model: result.response.modelId ?? modelId,
  };
}

export async function runEvidenceTool(toolName: ToolName, tokenAddress: string): Promise<EvidenceItem> {
  const address = tokenAddress.toLowerCase();

  try {
    if (toolName === "rpc_getBytecode") {
      const bytecode = await getBytecode(address);

      return {
        id: buildEvidenceId("ev_rpc_code"),
        tool: toolName,
        title: "Base RPC bytecode lookup",
        sourceUrl: process.env.BASE_RPC_URL ?? null,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          address,
          hasCode: bytecode !== "0x",
          bytecodeSizeBytes: bytecode === "0x" ? 0 : (bytecode.length - 2) / 2,
        },
        error: null,
      };
    }

    if (toolName === "rpc_getErc20Metadata") {
      const metadata = await getErc20Metadata(address);

      return {
        id: buildEvidenceId("ev_rpc_meta"),
        tool: toolName,
        title: "Base RPC ERC-20 metadata lookup",
        sourceUrl: process.env.BASE_RPC_URL ?? null,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          address,
          ...metadata,
        },
        error: null,
      };
    }

    if (toolName === "basescan_getSourceInfo") {
      const result = await getBaseContractVerification(address);

      return {
        id: buildEvidenceId("ev_basescan"),
        tool: toolName,
        title: "BaseScan contract source verification",
        sourceUrl: result.sourceUrl,
        fetchedAt: toTimestamp(),
        status: result.error ? "unavailable" : "ok",
        data: {
          address,
          isVerified: result.isVerified,
        },
        error: result.error,
      };
    }

    const result = await getDexPairsForBaseToken(address);
    const sortedPairs = [...result.pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const bestPair = sortedPairs[0] ?? null;

    return {
      id: buildEvidenceId("ev_dex"),
      tool: toolName,
      title: "DexScreener Base market data",
      sourceUrl: result.sourceUrl,
      fetchedAt: toTimestamp(),
      status: result.error ? "unavailable" : "ok",
      data: {
        tokenAddress: address,
        pairCount: result.pairs.length,
        bestPair: bestPair
          ? {
              dex: bestPair.dexId,
              pairAddress: bestPair.pairAddress,
              liquidityUsd: bestPair.liquidity?.usd ?? null,
              priceUsd: bestPair.priceUsd ?? null,
              priceChangeH24: bestPair.priceChange?.h24 ?? null,
              volumeH24: bestPair.volume?.h24 ?? null,
              txnsH24: bestPair.txns?.h24 ?? null,
            }
          : null,
        pairs: sortedPairs.slice(0, 5).map((pair) => ({
          dex: pair.dexId,
          pairAddress: pair.pairAddress,
          liquidityUsd: pair.liquidity?.usd ?? null,
          quoteSymbol: pair.quoteToken?.symbol ?? null,
          pairUrl: pair.url,
        })),
      },
      error: result.error,
    };
  } catch (error) {
    return {
      id: buildEvidenceId(`ev_${toolName}`),
      tool: toolName,
      title: TOOL_METADATA[toolName].title,
      sourceUrl: null,
      fetchedAt: toTimestamp(),
      status: "unavailable",
      data: {
        tokenAddress: address,
      },
      error: error instanceof Error ? error.message : "Tool execution failed",
    };
  }
}

export async function assessBaseScan(tokenAddress: string, evidenceItems: EvidenceItem[]) {
  const cerebras = getProvider();
  const modelId = getModelId();

  const condensedEvidence = evidenceItems.map((item) => ({
    id: item.id,
    tool: item.tool,
    title: item.title,
    status: item.status,
    error: item.error,
    data: item.data,
  }));

  const runAssessment = async (candidateModel: string) =>
    generateText({
      model: cerebras(candidateModel),
      temperature: 0,
      system:
        "You are Drona assessor. Return a strict risk assessment JSON from evidence only. Never invent facts. If data is missing, set lower confidence and list missingData.",
      prompt: `Token address: ${tokenAddress}\nEvidence JSON:\n${JSON.stringify(condensedEvidence)}\n\nEvery reason must include evidenceRefs using ids from evidence JSON.`,
      output: Output.object({
        schema: assessmentSchema,
        name: "drona_assessment",
        description: "Evidence-backed token risk assessment",
      }),
      providerOptions: {
        cerebras: {
          strictJsonSchema: false,
        },
      },
      maxOutputTokens: 1400,
    });

  let result;
  try {
    result = await runAssessment(modelId);
  } catch (error) {
    const shouldRetry = modelId !== FALLBACK_MODEL_ID && error instanceof Error && error.message.includes("No output generated");

    if (!shouldRetry) {
      throw error;
    }

    result = await runAssessment(FALLBACK_MODEL_ID);
  }

  const assessment = assessmentSchema.parse(result.output);

  if (assessment.summary.trim().length === 0) {
    throw new Error("Assessment summary is empty");
  }

  assertReasonCitations(assessment.reasons, evidenceItems);

  return {
    assessment,
    model: result.response.modelId ?? modelId,
  };
}

export { assessmentSchema };
export type { EvidenceItem, PlannedStep, ToolName };
