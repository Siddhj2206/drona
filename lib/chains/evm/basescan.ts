const ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api";
const BASE_CHAIN_ID = "8453";
const DEFAULT_TIMEOUT_MS = 10_000;

type SourceCodeItem = {
  SourceCode?: string;
  ABI?: string;
};

type BaseScanResponse = {
  status: string;
  message: string;
  result: SourceCodeItem[] | string;
};

type VerificationResult = {
  isVerified: boolean | null;
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

export async function getBaseContractVerification(address: string): Promise<VerificationResult> {
  const apiKey = process.env.ETHERSCAN_API_KEY ?? process.env.BASESCAN_API_KEY;

  if (!apiKey) {
    return {
      isVerified: null,
      sourceUrl: `${ETHERSCAN_V2_API_URL}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${address}`,
      error: "ETHERSCAN_API_KEY (or BASESCAN_API_KEY) is not set",
    };
  }

  const params = new URLSearchParams({
    chainid: BASE_CHAIN_ID,
    module: "contract",
    action: "getsourcecode",
    address,
    apikey: apiKey,
  });
  const sourceUrl = `${ETHERSCAN_V2_API_URL}?${params.toString()}`;
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        isVerified: null,
        sourceUrl,
        error: `Etherscan request failed with ${response.status}`,
      };
    }

    const json = (await response.json()) as BaseScanResponse;

    if (json.status === "0" && typeof json.result === "string") {
      return {
        isVerified: null,
        sourceUrl,
        error: `Etherscan error: ${json.result}`,
      };
    }

    if (!Array.isArray(json.result) || json.result.length === 0) {
      return {
        isVerified: null,
        sourceUrl,
        error: "Etherscan returned an unexpected response",
      };
    }

    const first = json.result[0];
    const sourceCode = first?.SourceCode ?? "";
    const abi = first?.ABI ?? "";
    const isVerified = sourceCode.trim().length > 0 && abi !== "Contract source code not verified";

    return {
      isVerified,
      sourceUrl,
      error: null,
    };
  } catch (error) {
      return {
        isVerified: null,
        sourceUrl,
        error: error instanceof Error ? error.message : "Etherscan request failed",
      };
  } finally {
    clear();
  }
}
