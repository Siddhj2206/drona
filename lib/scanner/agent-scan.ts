import { generateText, Output } from "ai";
import { createCerebras } from "@ai-sdk/cerebras";
import { z } from "zod";
import { getBytecode, getErc20Metadata } from "@/lib/chains/evm/base-rpc";
import { getBaseContractVerification } from "@/lib/chains/evm/basescan";
import { getTopHoldersFromBitquery } from "@/lib/chains/evm/bitquery-holders";
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
    "holders_getTopHolders",
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
  holders_getTopHolders: {
    stepKey: "holders_distribution",
    title: "Fetch holder distribution",
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
    ...(process.env.BITQUERY_ACCESS_TOKEN ? (["holders_getTopHolders"] as ToolName[]) : []),
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

  if (process.env.BITQUERY_ACCESS_TOKEN && !deduped.includes("holders_getTopHolders")) {
    deduped.push("holders_getTopHolders");
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

function hydrateMissingEvidenceRefs(
  reasons: z.infer<typeof assessmentSchema>["reasons"],
  evidenceItems: EvidenceItem[],
) {
  const allEvidenceIds = evidenceItems.map((item) => item.id);

  return reasons.map((reason) => {
    if (reason.evidenceRefs.length > 0) {
      return reason;
    }

    return {
      ...reason,
      evidenceRefs: allEvidenceIds,
    };
  });
}

export async function planBaseScan(tokenAddress: string) {
  const cerebras = getProvider();
  const modelId = getModelId();
  const hasBaseScan = Boolean(process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY);
  const hasHolders = Boolean(process.env.BITQUERY_ACCESS_TOKEN);

  const runPlan = async (candidateModel: string) =>
    generateText({
      model: cerebras(candidateModel),
      temperature: 0,
      system:
        "You are Drona planner. Produce a concise investigation tool plan for a Base token risk scan. Use only allowed tools. No explanations outside JSON.",
      prompt: `Token address: ${tokenAddress}\nAllowed tools: rpc_getBytecode, rpc_getErc20Metadata, dexscreener_getPairs${hasBaseScan ? ", basescan_getSourceInfo" : ""}${hasHolders ? ", holders_getTopHolders" : ""}.\nBaseScan tool availability: ${hasBaseScan ? "available" : "unavailable"}.\nHolders tool availability: ${hasHolders ? "available" : "unavailable"}.\nReturn ordered steps from most essential to optional.`,
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

function parseNumericString(input: string) {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function inferHolderTokens(amount: string, decimals: number | null) {
  const parsed = parseNumericString(amount);
  if (parsed === null) {
    return null;
  }

  if (amount.includes(".")) {
    return parsed;
  }

  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (typeof decimals === "number" && decimals >= 0) {
    const divided = parsed / 10 ** Math.min(decimals, 18);
    if (divided > 0 && divided < parsed) {
      return divided;
    }
  }

  return parsed;
}

export async function runEvidenceTool(
  toolName: ToolName,
  tokenAddress: string,
  context?: { evidenceItems?: EvidenceItem[] },
): Promise<EvidenceItem> {
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

    if (toolName === "holders_getTopHolders") {
      const holdersResult = await getTopHoldersFromBitquery(address, 10);
      const metadataEvidence = (context?.evidenceItems ?? []).find((item) => item.tool === "rpc_getErc20Metadata");
      const decimalsRaw = metadataEvidence?.data.decimals;
      const totalSupplyRaw = metadataEvidence?.data.totalSupply;
      const decimals = typeof decimalsRaw === "number" ? decimalsRaw : null;
      const totalSupplyTokens =
        typeof totalSupplyRaw === "string" && decimals !== null
          ? parseNumericString(totalSupplyRaw) !== null
            ? (parseNumericString(totalSupplyRaw) as number) / 10 ** Math.min(decimals, 18)
            : null
          : null;

      const topFive = holdersResult.holders.slice(0, 5);
      const topTen = holdersResult.holders.slice(0, 10);

      const withContracts = await Promise.all(
        topFive.map(async (holder) => {
          try {
            const code = await getBytecode(holder.address);
            return {
              ...holder,
              isContract: code !== "0x",
            };
          } catch {
            return {
              ...holder,
              isContract: null,
            };
          }
        }),
      );

      const canComputeSupplyPct = holdersResult.method === "token_holders";
      const amountValues = withContracts.map((holder) => parseNumericString(holder.amount) ?? 0);
      const amountTotal = amountValues.reduce((sum, value) => sum + value, 0);

      const mappedTopFive = withContracts.map((holder) => {
        const amountTokens = inferHolderTokens(holder.amount, decimals);
        const pctOfSupply =
          canComputeSupplyPct && amountTokens !== null && totalSupplyTokens !== null && totalSupplyTokens > 0
            ? Number(((amountTokens / totalSupplyTokens) * 100).toFixed(4))
            : null;
        const amountValue = parseNumericString(holder.amount);
        const relativeSharePct =
          amountValue !== null && amountTotal > 0 ? Number(((amountValue / amountTotal) * 100).toFixed(4)) : null;

        return {
          address: holder.address,
          amount: holder.amount,
          amountTokens,
          pctOfSupply,
          relativeSharePct,
          isContract: holder.isContract,
        };
      });

      const mappedTopTen = topTen.map((holder) => {
        const amountTokens = inferHolderTokens(holder.amount, decimals);
        const pctOfSupply =
          canComputeSupplyPct && amountTokens !== null && totalSupplyTokens !== null && totalSupplyTokens > 0
            ? Number(((amountTokens / totalSupplyTokens) * 100).toFixed(4))
            : null;

        return {
          address: holder.address,
          amount: holder.amount,
          amountTokens,
          pctOfSupply,
        };
      });

      const hasSupplyPct = mappedTopFive.some((holder) => holder.pctOfSupply !== null);
      const top5Pct = hasSupplyPct
        ? mappedTopFive.reduce((sum, holder) => sum + (holder.pctOfSupply ?? 0), 0)
        : null;
      const top10Pct = hasSupplyPct
        ? mappedTopTen.reduce((sum, holder) => sum + (holder.pctOfSupply ?? 0), 0)
        : null;

      return {
        id: buildEvidenceId("ev_holders"),
        tool: toolName,
        title: "Bitquery holder distribution",
        sourceUrl: holdersResult.sourceUrl,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          tokenAddress: address,
          asOfDate: holdersResult.asOfDate,
          attemptedDates: holdersResult.attemptedDates,
          method: holdersResult.method,
          topHolders: mappedTopFive,
          top10: mappedTopTen,
          top5Pct,
          top10Pct,
          decimals,
          totalSupplyTokens,
          notes:
            holdersResult.method === "balance_updates"
              ? "Holder ranking approximated from BalanceUpdates (USD-based)."
              : undefined,
        },
        error: null,
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
  assessment.reasons = hydrateMissingEvidenceRefs(assessment.reasons, evidenceItems);

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
