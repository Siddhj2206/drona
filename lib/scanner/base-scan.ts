import { getBytecode } from "@/lib/chains/evm/base-rpc";
import { getBaseContractVerification } from "@/lib/chains/evm/basescan";
import { getDexPairsForBaseToken, type PairInfo } from "@/lib/chains/evm/dexscreener";

type BaseScanInput = {
  scanId: string;
  tokenAddress: string;
  startedAt: Date;
};

type BaseScanResult = {
  evidence: Record<string, unknown>;
  score: Record<string, unknown>;
  durationMs: number;
  narrative: string;
};

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function pickBestPair(pairs: PairInfo[]) {
  if (pairs.length === 0) {
    return null;
  }

  return [...pairs].sort((a, b) => {
    const liquidityA = a.liquidity?.usd ?? 0;
    const liquidityB = b.liquidity?.usd ?? 0;
    return liquidityB - liquidityA;
  })[0] ?? null;
}

function getRiskLevel(score: number) {
  if (score <= 30) return "low";
  if (score <= 60) return "medium";
  if (score <= 80) return "high";
  return "critical";
}

function buildScore(bestPair: PairInfo | null, hasContractCode: boolean) {
  const liquidityUsd = bestPair?.liquidity?.usd ?? 0;
  const priceChangeH24 = Math.abs(bestPair?.priceChange?.h24 ?? 0);
  const volumeH24 = bestPair?.volume?.h24 ?? 0;

  const contractRisk = hasContractCode ? 20 : 100;

  let liquidityRisk = 90;
  if (liquidityUsd >= 100_000) {
    liquidityRisk = 15;
  } else if (liquidityUsd >= 20_000) {
    liquidityRisk = 35;
  } else if (liquidityUsd >= 5_000) {
    liquidityRisk = 60;
  }

  let behaviorRisk = 35;
  if (priceChangeH24 >= 30 && volumeH24 >= 10_000) {
    behaviorRisk = 75;
  } else if (priceChangeH24 >= 15) {
    behaviorRisk = 55;
  }

  const distributionRisk = 50;
  const honeypotRisk = 50;
  const overall = Math.min(
    100,
    Math.round((contractRisk + liquidityRisk + behaviorRisk + distributionRisk + honeypotRisk) / 5),
  );

  return {
    overall,
    riskLevel: getRiskLevel(overall),
    categories: {
      contractRisk,
      liquidityRisk,
      behaviorRisk,
      distributionRisk,
      honeypotRisk,
    },
  };
}

export async function runBaseTokenScan({ scanId, tokenAddress, startedAt }: BaseScanInput): Promise<BaseScanResult> {
  const bytecode = await getBytecode(tokenAddress);

  if (bytecode === "0x") {
    throw new Error("Provided address is not a contract on Base");
  }

  const verification = await getBaseContractVerification(tokenAddress);

  let dexData = {
    pairs: [] as PairInfo[],
    sourceUrl: `${process.env.DEX_API_BASE_URL ?? "https://api.dexscreener.com"}/token-pairs/v1/base/${tokenAddress}`,
    error: null as string | null,
  };

  try {
    dexData = await getDexPairsForBaseToken(tokenAddress);
  } catch (error) {
    dexData = {
      pairs: [],
      sourceUrl: `${process.env.DEX_API_BASE_URL ?? "https://api.dexscreener.com"}/token-pairs/v1/base/${tokenAddress}`,
      error: error instanceof Error ? error.message : "DexScreener fetch failed",
    };
  }

  const bestPair = pickBestPair(dexData.pairs);
  const now = new Date();
  const durationMs = now.getTime() - startedAt.getTime();

  const priceUsd = toNumber(bestPair?.priceUsd);
  const priceChangeH24 = bestPair?.priceChange?.h24 ?? null;
  const volumeH24 = bestPair?.volume?.h24 ?? null;
  const liquidityUsd = bestPair?.liquidity?.usd ?? null;
  const txnsH24 = bestPair?.txns?.h24 ?? null;
  const flags: string[] = [];

  if (typeof liquidityUsd === "number" && liquidityUsd < 5_000) {
    flags.push("low_liquidity");
  }

  if (dexData.error) {
    flags.push("dex_data_unavailable");
  }

  if (typeof priceChangeH24 === "number" && Math.abs(priceChangeH24) >= 30) {
    flags.push("high_24h_volatility");
  }

  if (
    typeof priceChangeH24 === "number" &&
    typeof volumeH24 === "number" &&
    volumeH24 >= 10_000 &&
    priceChangeH24 >= 30
  ) {
    flags.push("pump_pattern_signal");
  }

  if (
    typeof priceChangeH24 === "number" &&
    typeof volumeH24 === "number" &&
    volumeH24 >= 10_000 &&
    priceChangeH24 <= -30
  ) {
    flags.push("dump_pattern_signal");
  }

  const evidence = {
    meta: {
      scanId,
      chain: "base",
      tokenAddress,
      startedAt: startedAt.toISOString(),
      finishedAt: now.toISOString(),
      durationMs,
      scannerVersion: "v0-deterministic",
      scoreVersion: "v0",
    },
    token: {
      name: bestPair?.baseToken?.name ?? "Unknown",
      symbol: bestPair?.baseToken?.symbol ?? "UNKNOWN",
    },
    contract: {
      hasContractCode: true,
      bytecodeSizeBytes: (bytecode.length - 2) / 2,
      isVerified: verification.isVerified,
      verificationSource: verification.sourceUrl,
      verificationError: verification.error,
    },
    dex: {
      status: dexData.error ? "unavailable" : "ok",
      error: dexData.error,
      pairs: dexData.pairs.slice(0, 5).map((pair) => ({
        dex: pair.dexId,
        pairAddress: pair.pairAddress,
        quoteSymbol: pair.quoteToken?.symbol ?? null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        pairUrl: pair.url,
      })),
      bestPair: bestPair
        ? {
            dex: bestPair.dexId,
            pairAddress: bestPair.pairAddress,
            pairUrl: bestPair.url,
            priceUsd,
            liquidityUsd,
            pairCreatedAt: bestPair.pairCreatedAt ?? null,
          }
        : null,
      liquidity: {
        liquidityUsd,
        lpLockStatus: "unknown",
      },
    },
    distribution: {
      topHolders: [],
      top10Pct: null,
      status: "unknown",
    },
    trading: {
      buySellCounts: {
        h24: txnsH24,
      },
      sellability: {
        status: "unknown",
        method: "not_checked",
        evidence: ["Sell simulation not implemented in v0"],
      },
    },
    behavior: {
      priceSeries: {
        h24ChangePct: priceChangeH24,
        source: "dexscreener",
      },
      volumeSeries: {
        h24VolumeUsd: volumeH24,
        source: "dexscreener",
      },
      flags,
    },
    rawSources: {
      rpcMethod: "eth_getCode",
      baseScanEndpoint: verification.sourceUrl,
      dexscreenerEndpoint: dexData.sourceUrl,
    },
  };

  const score = buildScore(bestPair, true);
  const narrative =
    bestPair === null
      ? dexData.error
        ? "DEX market data is currently unavailable, so liquidity and trading behavior could not be evaluated in this scan."
        : "No active DEX pairs were found for this token on Base. Liquidity and trading behavior are unknown, which increases uncertainty."
      : `Top pair on ${bestPair.dexId} shows approximately $${Math.round(bestPair.liquidity?.usd ?? 0).toLocaleString()} liquidity and ${bestPair.priceChange?.h24 ?? 0}% 24h price movement.`;

  return {
    evidence,
    score,
    durationMs,
    narrative,
  };
}
