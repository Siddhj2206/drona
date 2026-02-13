import { generateText, Output } from "ai";
import { createCerebras } from "@ai-sdk/cerebras";
import { z } from "zod";
import { baseRpcCall, getBytecode, getErc20Metadata } from "@/lib/chains/evm/base-rpc";
import { getBaseContractCreation, getBaseContractSourceInfo } from "@/lib/chains/evm/basescan";
import { getTopHoldersFromBitquery } from "@/lib/chains/evm/bitquery-holders";
import { getDexPairsForBaseToken } from "@/lib/chains/evm/dexscreener";
import { getV2LpLockStatus } from "@/lib/chains/evm/lp-v2-lock";
import { getHoneypotSwapResult } from "@/lib/chains/honeypot";

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
    "basescan_getContractCreation",
    "dexscreener_getPairs",
    "honeypot_getSimulation",
    "lp_v2_lockStatus",
    "contract_ownerStatus",
    "contract_capabilityScan",
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
  basescan_getContractCreation: {
    stepKey: "basescan_creation",
    title: "Fetch contract creation info",
  },
  dexscreener_getPairs: {
    stepKey: "dex_market",
    title: "Fetch DEX market data",
  },
  honeypot_getSimulation: {
    stepKey: "swap_honeypot",
    title: "Run honeypot swap simulation",
  },
  lp_v2_lockStatus: {
    stepKey: "lp_lock",
    title: "Analyze V2 LP lock status",
  },
  contract_ownerStatus: {
    stepKey: "contract_owner",
    title: "Check ownership status",
  },
  contract_capabilityScan: {
    stepKey: "contract_capabilities",
    title: "Scan admin capabilities",
  },
  holders_getTopHolders: {
    stepKey: "holders_distribution",
    title: "Fetch holder distribution",
  },
};

const REQUIRED_TOOLS: ToolName[] = [
  "rpc_getBytecode",
  "rpc_getErc20Metadata",
  "dexscreener_getPairs",
  "honeypot_getSimulation",
];

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
  const hasBaseScan = Boolean(process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY);
  const availableTools = new Set<ToolName>([
    "rpc_getBytecode",
    "rpc_getErc20Metadata",
    "dexscreener_getPairs",
    "honeypot_getSimulation",
    "lp_v2_lockStatus",
    ...(process.env.BITQUERY_ACCESS_TOKEN ? (["holders_getTopHolders"] as ToolName[]) : []),
    ...(hasBaseScan
      ? ([
          "basescan_getSourceInfo",
          "basescan_getContractCreation",
          "contract_ownerStatus",
          "contract_capabilityScan",
        ] as ToolName[])
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

  if (hasBaseScan) {
    for (const toolName of [
      "basescan_getSourceInfo",
      "basescan_getContractCreation",
      "contract_ownerStatus",
      "contract_capabilityScan",
    ] as ToolName[]) {
      if (!deduped.includes(toolName)) {
        deduped.push(toolName);
      }
    }
  }

  if (!deduped.includes("lp_v2_lockStatus")) {
    deduped.push("lp_v2_lockStatus");
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

function isNoOutputError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("no output generated");
}

function truncateText(input: string, maxLength: number) {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxLength - 1))}...`;
}

function compactUnknown(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value, 220);
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `array(${value.length})`;
    }
    return value.slice(0, 5).map((entry) => compactUnknown(entry, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= 2) {
      return "object";
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
    return Object.fromEntries(entries.map(([key, entry]) => [key, compactUnknown(entry, depth + 1)]));
  }

  return String(value);
}

function buildAssessmentEvidenceVariants(evidenceItems: EvidenceItem[]) {
  const full = evidenceItems.map((item) => ({
    id: item.id,
    tool: item.tool,
    title: item.title,
    status: item.status,
    error: item.error,
    data: item.data,
  }));

  const compact = evidenceItems.map((item) => ({
    id: item.id,
    tool: item.tool,
    title: item.title,
    status: item.status,
    error: item.error ? truncateText(item.error, 180) : null,
    data: compactUnknown(item.data),
  }));

  return [full, compact];
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
      prompt: `Token address: ${tokenAddress}\nAllowed tools: rpc_getBytecode, rpc_getErc20Metadata, dexscreener_getPairs, honeypot_getSimulation, lp_v2_lockStatus${hasBaseScan ? ", basescan_getSourceInfo, basescan_getContractCreation, contract_ownerStatus, contract_capabilityScan" : ""}${hasHolders ? ", holders_getTopHolders" : ""}.\nBaseScan tool availability: ${hasBaseScan ? "available" : "unavailable"}.\nHolders tool availability: ${hasHolders ? "available" : "unavailable"}.\nReturn ordered steps from most essential to optional.`,
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

const TEN = BigInt(10);
const POW10_CACHE = new Map<number, bigint>([[0, BigInt(1)]]);

function pow10(exponent: number) {
  if (exponent < 0 || !Number.isInteger(exponent)) {
    throw new Error(`Invalid exponent for pow10: ${exponent}`);
  }
  const cached = POW10_CACHE.get(exponent);
  if (cached !== undefined) {
    return cached;
  }
  const computed = TEN ** BigInt(exponent);
  POW10_CACHE.set(exponent, computed);
  return computed;
}

function parseDecimalToScaledBigInt(input: string, scale: number) {
  if (scale < 0 || !Number.isInteger(scale)) {
    return null;
  }
  const trimmed = input.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const [wholeRaw, fractionRaw = ""] = trimmed.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const fraction = fractionRaw.slice(0, scale).padEnd(scale, "0");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");

  try {
    return BigInt(digits || "0");
  } catch {
    return null;
  }
}

function ratioToPercent(numerator: bigint, denominator: bigint, precision = 4) {
  if (denominator <= BigInt(0) || numerator < BigInt(0) || precision < 0 || !Number.isInteger(precision)) {
    return null;
  }

  const percentScale = pow10(precision);
  const scaled = (numerator * BigInt(100) * percentScale) / denominator;
  return Number(scaled) / Number(percentScale);
}

function inferHolderTokenAmount(amount: string) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEvidenceDataByTool(evidenceItems: EvidenceItem[] | undefined, toolName: ToolName) {
  return (evidenceItems ?? []).find((item) => item.tool === toolName)?.data;
}

function parseOwnerAddressFromCallResult(hex: string | null) {
  if (!hex || !hex.startsWith("0x") || hex.length < 66) {
    return null;
  }

  const tail = hex.slice(-40);
  return `0x${tail}`.toLowerCase();
}

function extractAbiFunctionNames(abi: unknown[] | null) {
  if (!Array.isArray(abi)) {
    return [] as string[];
  }

  return abi
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const maybeType = (entry as { type?: unknown }).type;
      const maybeName = (entry as { name?: unknown }).name;
      if (maybeType !== "function" || typeof maybeName !== "string") {
        return null;
      }
      return maybeName;
    })
    .filter((name): name is string => Boolean(name));
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
      const result = await getBaseContractSourceInfo(address);

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
          contractName: result.contractName,
          compilerVersion: result.compilerVersion,
          isProxy: result.isProxy,
          implementationAddress: result.implementationAddress,
          abi: result.abi,
          abiError: result.abiError,
        },
        error: result.error,
      };
    }

    if (toolName === "basescan_getContractCreation") {
      const result = await getBaseContractCreation(address);

      return {
        id: buildEvidenceId("ev_creation"),
        tool: toolName,
        title: "BaseScan contract creation details",
        sourceUrl: result.sourceUrl,
        fetchedAt: toTimestamp(),
        status: result.error ? "unavailable" : "ok",
        data: {
          address,
          deployerAddress: result.deployerAddress,
          creationTxHash: result.creationTxHash,
        },
        error: result.error,
      };
    }

    if (toolName === "honeypot_getSimulation") {
      const result = await getHoneypotSwapResult(address);

      return {
        id: buildEvidenceId("ev_honeypot"),
        tool: toolName,
        title: "Honeypot.is swap simulation",
        sourceUrl: result.sourceUrl,
        fetchedAt: toTimestamp(),
        status: result.error ? "unavailable" : "ok",
        data: {
          address,
          simulationSuccess: result.simulationSuccess,
          isHoneypot: result.isHoneypot,
          sellable: result.sellable,
          buyTax: result.buyTax,
          sellTax: result.sellTax,
          transferTax: result.transferTax,
          buyGas: result.buyGas,
          sellGas: result.sellGas,
          risk: result.risk,
          riskLevel: result.riskLevel,
          openSource: result.openSource,
          isProxy: result.isProxy,
          pairAddress: result.pairAddress,
          pairType: result.pairType,
        },
        error: result.error,
      };
    }

    if (toolName === "contract_ownerStatus") {
      const sourceData = getEvidenceDataByTool(context?.evidenceItems, "basescan_getSourceInfo");
      const sourceAbi = Array.isArray(sourceData?.abi) ? sourceData.abi : null;
      const abiFunctionNames = extractAbiFunctionNames(sourceAbi);
      const hasOwnerFunction = abiFunctionNames.includes("owner");

      let ownerAddress: string | null = null;
      let ownerLookupError: string | null = null;
      if (hasOwnerFunction) {
        try {
          const ownerCall = await baseRpcCall<string>("eth_call", [
            {
              to: address,
              data: "0x8da5cb5b",
            },
            "latest",
          ]);
          ownerAddress = parseOwnerAddressFromCallResult(ownerCall);
        } catch (error) {
          ownerLookupError = error instanceof Error ? error.message : "owner() call failed";
        }
      }

      const renounced =
        ownerAddress === null
          ? null
          : ownerAddress === "0x0000000000000000000000000000000000000000" ||
              ownerAddress === "0x000000000000000000000000000000000000dead";

      return {
        id: buildEvidenceId("ev_owner"),
        tool: toolName,
        title: "Ownership status analysis",
        sourceUrl: process.env.BASE_RPC_URL ?? null,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          address,
          hasOwnerFunction,
          ownerAddress,
          renounced,
          ownerLookupError,
        },
        error: null,
      };
    }

    if (toolName === "contract_capabilityScan") {
      const sourceData = getEvidenceDataByTool(context?.evidenceItems, "basescan_getSourceInfo");
      const sourceAbi = Array.isArray(sourceData?.abi) ? sourceData.abi : null;
      const functionNames = extractAbiFunctionNames(sourceAbi);
      const lowerNames = functionNames.map((name) => name.toLowerCase());

      const hasAny = (needles: string[]) => lowerNames.some((name) => needles.some((needle) => name.includes(needle)));

      return {
        id: buildEvidenceId("ev_caps"),
        tool: toolName,
        title: "Contract capability scan",
        sourceUrl: typeof sourceData?.sourceUrl === "string" ? sourceData.sourceUrl : null,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          address,
          functionNames,
          mintPossible: hasAny(["mint"]),
          canBlacklist: hasAny(["blacklist", "blocklist"]),
          canPause: hasAny(["pause", "unpause"]),
          canSetFees: hasAny(["setfee", "tax", "settax", "setbuy", "setsell"]),
          hasTradingToggle: hasAny(["trading", "enabletrading", "disabletrading"]),
          upgradeableProxy: typeof sourceData?.isProxy === "boolean" ? sourceData.isProxy : null,
        },
        error: null,
      };
    }

    if (toolName === "lp_v2_lockStatus") {
      const dexData = getEvidenceDataByTool(context?.evidenceItems, "dexscreener_getPairs");
      const creationData = getEvidenceDataByTool(context?.evidenceItems, "basescan_getContractCreation");
      const cachedPair =
        dexData && typeof dexData.bestPair === "object" && dexData.bestPair !== null
          ? (dexData.bestPair as { pairAddress?: unknown }).pairAddress
          : null;
      const pairAddress =
        typeof cachedPair === "string"
          ? cachedPair
          : (() => {
              throw new Error("DEX pair data unavailable for LP lock analysis");
            })();
      const deployerAddress =
        creationData && typeof creationData.deployerAddress === "string" ? creationData.deployerAddress : null;
      const result = await getV2LpLockStatus(pairAddress, deployerAddress);

      return {
        id: buildEvidenceId("ev_lp"),
        tool: toolName,
        title: "V2 LP lock status",
        sourceUrl: process.env.BASE_RPC_URL ?? null,
        fetchedAt: toTimestamp(),
        status: "ok",
        data: {
          tokenAddress: address,
          ...result,
        },
        error: null,
      };
    }

    if (toolName === "holders_getTopHolders") {
      const holdersResult = await getTopHoldersFromBitquery(address, 10);
      const metadataEvidence = (context?.evidenceItems ?? []).find((item) => item.tool === "rpc_getErc20Metadata");
      const decimalsRaw = metadataEvidence?.data.decimals;
      const totalSupplyRaw = metadataEvidence?.data.totalSupply;
      const decimals = typeof decimalsRaw === "number" ? decimalsRaw : null;
      const canComputeSupplyPct = holdersResult.method === "token_holders";
      const normalizedDecimals = typeof decimals === "number" && decimals >= 0 ? Math.min(decimals, 36) : null;
      const totalSupplyUnits =
        canComputeSupplyPct && typeof totalSupplyRaw === "string" && normalizedDecimals !== null
          ? parseDecimalToScaledBigInt(totalSupplyRaw, 0)
          : null;
      const totalSupplyTokens =
        totalSupplyUnits !== null && normalizedDecimals !== null
          ? Number(totalSupplyUnits) / 10 ** Math.min(normalizedDecimals, 18)
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

      const relativeScale = 18;
      const amountValues = withContracts.map((holder) => parseDecimalToScaledBigInt(holder.amount, relativeScale) ?? BigInt(0));
      const amountTotal = amountValues.reduce((sum, value) => sum + value, BigInt(0));

      const mappedTopFive = withContracts.map((holder) => {
        const amountTokens = inferHolderTokenAmount(holder.amount);
        const amountUnits =
          canComputeSupplyPct && normalizedDecimals !== null
            ? parseDecimalToScaledBigInt(holder.amount, normalizedDecimals)
            : null;
        const pctOfSupply =
          canComputeSupplyPct && amountUnits !== null && totalSupplyUnits !== null
            ? ratioToPercent(amountUnits, totalSupplyUnits, 4)
            : null;
        const amountValue = parseDecimalToScaledBigInt(holder.amount, relativeScale);
        const relativeSharePct =
          amountValue !== null && amountTotal > BigInt(0) ? ratioToPercent(amountValue, amountTotal, 4) : null;

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
        const amountTokens = inferHolderTokenAmount(holder.amount);
        const amountUnits =
          canComputeSupplyPct && normalizedDecimals !== null
            ? parseDecimalToScaledBigInt(holder.amount, normalizedDecimals)
            : null;
        const pctOfSupply =
          canComputeSupplyPct && amountUnits !== null && totalSupplyUnits !== null
            ? ratioToPercent(amountUnits, totalSupplyUnits, 4)
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
          amountSemantics: holdersResult.method === "balance_updates" ? "usd_weighted" : "token_balance",
          supplyPctAvailable: canComputeSupplyPct,
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

  const runAssessment = async (
    candidateModel: string,
    evidencePayload: ReturnType<typeof buildAssessmentEvidenceVariants>[number],
  ) =>
    generateText({
      model: cerebras(candidateModel),
      temperature: 0,
      system:
        "You are Drona assessor. Return a strict risk assessment JSON from evidence only. Never invent facts. If data is missing, set lower confidence and list missingData.",
      prompt: `Token address: ${tokenAddress}\nEvidence JSON:\n${JSON.stringify(evidencePayload)}\n\nEvery reason must include evidenceRefs using ids from evidence JSON.`,
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

  const candidateModels = modelId === FALLBACK_MODEL_ID ? [modelId] : [modelId, FALLBACK_MODEL_ID];
  const evidenceVariants = buildAssessmentEvidenceVariants(evidenceItems);

  let lastError: unknown = null;

  for (const candidateModel of candidateModels) {
    for (let variantIndex = 0; variantIndex < evidenceVariants.length; variantIndex += 1) {
      try {
        const result = await runAssessment(candidateModel, evidenceVariants[variantIndex]);
        const assessment = assessmentSchema.parse(result.output);
        assessment.reasons = hydrateMissingEvidenceRefs(assessment.reasons, evidenceItems);

        if (assessment.summary.trim().length === 0) {
          throw new Error("Assessment summary is empty");
        }

        assertReasonCitations(assessment.reasons, evidenceItems);

        return {
          assessment,
          model: result.response.modelId ?? candidateModel,
        };
      } catch (error) {
        lastError = error;
        const hasMoreVariants = variantIndex < evidenceVariants.length - 1;
        if (hasMoreVariants && isNoOutputError(error)) {
          continue;
        }

        if (!hasMoreVariants) {
          break;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Assessment generation failed");
}

export { assessmentSchema };
export type { EvidenceItem, PlannedStep, ToolName };
