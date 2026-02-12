const DEFAULT_DEX_API_BASE_URL = "https://api.dexscreener.com";
const DEFAULT_TIMEOUT_MS = 10_000;

type PairInfo = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  pairCreatedAt?: number;
  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  quoteToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  priceUsd?: string;
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  priceChange?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
};

type GetTokenPairsResult = {
  pairs: PairInfo[];
  sourceUrl: string;
  error: string | null;
};

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export async function getDexPairsForBaseToken(tokenAddress: string): Promise<GetTokenPairsResult> {
  const apiBaseUrl = process.env.DEX_API_BASE_URL ?? DEFAULT_DEX_API_BASE_URL;
  const endpoint = `${apiBaseUrl}/token-pairs/v1/base/${tokenAddress}`;
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`DexScreener request failed with ${response.status}`);
    }

    const json = (await response.json()) as unknown;
    let pairs: PairInfo[] = [];

    if (Array.isArray(json)) {
      pairs = json as PairInfo[];
    } else if (typeof json === "object" && json !== null && "pairs" in json) {
      const maybePairs = (json as { pairs?: unknown }).pairs;
      pairs = Array.isArray(maybePairs) ? (maybePairs as PairInfo[]) : [];
    } else {
      return {
        pairs: [],
        sourceUrl: endpoint,
        error: "Unexpected DexScreener response shape",
      };
    }

    return {
      pairs,
      sourceUrl: endpoint,
      error: null,
    };
  } finally {
    clear();
  }
}

export type { PairInfo };
