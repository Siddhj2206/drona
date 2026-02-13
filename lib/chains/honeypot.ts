const DEFAULT_TIMEOUT_MS = 12_000;
const BASE_CHAIN_ID = "8453";

type HoneypotApiResponse = {
  simulationSuccess?: boolean;
  honeypotResult?: {
    isHoneypot?: boolean;
  };
  simulationResult?: {
    buyTax?: number;
    sellTax?: number;
    transferTax?: number;
    buyGas?: string;
    sellGas?: string;
  };
  summary?: {
    risk?: string;
    riskLevel?: string;
    flags?: unknown[];
  };
  contractCode?: {
    openSource?: boolean;
    rootOpenSource?: boolean;
    isProxy?: boolean;
    hasProxyCalls?: boolean;
  };
  pair?: {
    pairAddress?: string;
    pair?: {
      address?: string;
      type?: string;
      liquidity?: number;
      router?: string;
    };
  };
};

export type HoneypotSwapResult = {
  sourceUrl: string;
  error: string | null;
  simulationSuccess: boolean | null;
  isHoneypot: boolean | null;
  sellable: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  transferTax: number | null;
  buyGas: string | null;
  sellGas: string | null;
  risk: string | null;
  riskLevel: string | null;
  openSource: boolean | null;
  isProxy: boolean | null;
  pairAddress: string | null;
  pairType: string | null;
};

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export async function getHoneypotSwapResult(tokenAddress: string): Promise<HoneypotSwapResult> {
  const endpoint = new URL("https://api.honeypot.is/v2/IsHoneypot");
  endpoint.searchParams.set("address", tokenAddress.toLowerCase());
  endpoint.searchParams.set("chainID", BASE_CHAIN_ID);
  const sourceUrl = endpoint.toString();

  const apiKey = process.env.HONEYPOT_API_KEY;
  const headers: HeadersInit = {};
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
  }

  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers,
      signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        sourceUrl,
        error: `honeypot.is request failed with ${response.status}`,
        simulationSuccess: null,
        isHoneypot: null,
        sellable: null,
        buyTax: null,
        sellTax: null,
        transferTax: null,
        buyGas: null,
        sellGas: null,
        risk: null,
        riskLevel: null,
        openSource: null,
        isProxy: null,
        pairAddress: null,
        pairType: null,
      };
    }

    const json = (await response.json()) as HoneypotApiResponse;
    const simulationSuccess = typeof json.simulationSuccess === "boolean" ? json.simulationSuccess : null;
    const isHoneypot = typeof json.honeypotResult?.isHoneypot === "boolean" ? json.honeypotResult.isHoneypot : null;

    return {
      sourceUrl,
      error: null,
      simulationSuccess,
      isHoneypot,
      sellable: simulationSuccess === true && isHoneypot !== null ? !isHoneypot : null,
      buyTax: typeof json.simulationResult?.buyTax === "number" ? json.simulationResult.buyTax : null,
      sellTax: typeof json.simulationResult?.sellTax === "number" ? json.simulationResult.sellTax : null,
      transferTax: typeof json.simulationResult?.transferTax === "number" ? json.simulationResult.transferTax : null,
      buyGas: typeof json.simulationResult?.buyGas === "string" ? json.simulationResult.buyGas : null,
      sellGas: typeof json.simulationResult?.sellGas === "string" ? json.simulationResult.sellGas : null,
      risk: typeof json.summary?.risk === "string" ? json.summary.risk : null,
      riskLevel: typeof json.summary?.riskLevel === "string" ? json.summary.riskLevel : null,
      openSource: typeof json.contractCode?.openSource === "boolean" ? json.contractCode.openSource : null,
      isProxy: typeof json.contractCode?.isProxy === "boolean" ? json.contractCode.isProxy : null,
      pairAddress:
        typeof json.pair?.pairAddress === "string"
          ? json.pair.pairAddress
          : typeof json.pair?.pair?.address === "string"
            ? json.pair.pair.address
            : null,
      pairType: typeof json.pair?.pair?.type === "string" ? json.pair.pair.type : null,
    };
  } catch (error) {
    return {
      sourceUrl,
      error: error instanceof Error ? error.message : "honeypot.is request failed",
      simulationSuccess: null,
      isHoneypot: null,
      sellable: null,
      buyTax: null,
      sellTax: null,
      transferTax: null,
      buyGas: null,
      sellGas: null,
      risk: null,
      riskLevel: null,
      openSource: null,
      isProxy: null,
      pairAddress: null,
      pairType: null,
    };
  } finally {
    clear();
  }
}
