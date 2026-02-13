const ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api";
const BASE_CHAIN_ID = "8453";
const DEFAULT_TIMEOUT_MS = 10_000;

type SourceCodeItem = {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  CompilerVersion?: string;
  Proxy?: string;
  Implementation?: string;
};

type ContractCreationItem = {
  contractAddress?: string;
  contractCreator?: string;
  txHash?: string;
};

type BaseScanResponse<T> = {
  status: string;
  message: string;
  result: T[] | string;
};

export type VerificationResult = {
  isVerified: boolean | null;
  sourceUrl: string;
  error: string | null;
};

export type SourceInfoResult = VerificationResult & {
  contractName: string | null;
  compilerVersion: string | null;
  isProxy: boolean | null;
  implementationAddress: string | null;
  abi: unknown[] | null;
  abiError: string | null;
};

export type ContractCreationResult = {
  deployerAddress: string | null;
  creationTxHash: string | null;
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

function getApiKey() {
  return process.env.ETHERSCAN_API_KEY ?? process.env.BASESCAN_API_KEY;
}

function buildSourceCodeUrl(address: string, apiKey?: string) {
  const params = new URLSearchParams({
    chainid: BASE_CHAIN_ID,
    module: "contract",
    action: "getsourcecode",
    address,
    ...(apiKey ? { apikey: apiKey } : {}),
  });

  return `${ETHERSCAN_V2_API_URL}?${params.toString()}`;
}

function buildCreationUrl(address: string, apiKey?: string) {
  const params = new URLSearchParams({
    chainid: BASE_CHAIN_ID,
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: address,
    ...(apiKey ? { apikey: apiKey } : {}),
  });

  return `${ETHERSCAN_V2_API_URL}?${params.toString()}`;
}

async function fetchBaseScan<T>(sourceUrl: string): Promise<{ result: T[] | null; error: string | null }> {
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return { result: null, error: `Etherscan request failed with ${response.status}` };
    }

    const json = (await response.json()) as BaseScanResponse<T>;

    if (json.status === "0" && typeof json.result === "string") {
      return { result: null, error: `Etherscan error: ${json.result}` };
    }

    if (!Array.isArray(json.result) || json.result.length === 0) {
      return { result: null, error: "Etherscan returned an unexpected response" };
    }

    return { result: json.result, error: null };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Etherscan request failed",
    };
  } finally {
    clear();
  }
}

function parseAbi(abiRaw: string | undefined) {
  if (!abiRaw || abiRaw === "Contract source code not verified") {
    return { abi: null, abiError: null };
  }

  try {
    const parsed = JSON.parse(abiRaw) as unknown;
    return { abi: Array.isArray(parsed) ? parsed : null, abiError: null };
  } catch (error) {
    return {
      abi: null,
      abiError: error instanceof Error ? error.message : "ABI parse failed",
    };
  }
}

export async function getBaseContractSourceInfo(address: string): Promise<SourceInfoResult> {
  const apiKey = getApiKey();
  const sourceUrl = buildSourceCodeUrl(address, apiKey);

  if (!apiKey) {
    return {
      isVerified: null,
      sourceUrl,
      contractName: null,
      compilerVersion: null,
      isProxy: null,
      implementationAddress: null,
      abi: null,
      abiError: null,
      error: "ETHERSCAN_API_KEY (or BASESCAN_API_KEY) is not set",
    };
  }

  const fetched = await fetchBaseScan<SourceCodeItem>(sourceUrl);
  if (!fetched.result) {
    return {
      isVerified: null,
      sourceUrl,
      contractName: null,
      compilerVersion: null,
      isProxy: null,
      implementationAddress: null,
      abi: null,
      abiError: null,
      error: fetched.error,
    };
  }

  const first = fetched.result[0] ?? {};
  const sourceCode = first.SourceCode ?? "";
  const abiRaw = first.ABI ?? "";
  const isVerified = sourceCode.trim().length > 0 && abiRaw !== "Contract source code not verified";
  const parsedAbi = parseAbi(abiRaw);
  const implementationAddress =
    typeof first.Implementation === "string" && first.Implementation.startsWith("0x") && first.Implementation.length === 42
      ? first.Implementation.toLowerCase()
      : null;

  return {
    isVerified,
    sourceUrl,
    contractName: typeof first.ContractName === "string" ? first.ContractName : null,
    compilerVersion: typeof first.CompilerVersion === "string" ? first.CompilerVersion : null,
    isProxy: first.Proxy === "1" ? true : first.Proxy === "0" ? false : null,
    implementationAddress,
    abi: parsedAbi.abi,
    abiError: parsedAbi.abiError,
    error: fetched.error,
  };
}

export async function getBaseContractCreation(address: string): Promise<ContractCreationResult> {
  const apiKey = getApiKey();
  const sourceUrl = buildCreationUrl(address, apiKey);

  if (!apiKey) {
    return {
      deployerAddress: null,
      creationTxHash: null,
      sourceUrl,
      error: "ETHERSCAN_API_KEY (or BASESCAN_API_KEY) is not set",
    };
  }

  const fetched = await fetchBaseScan<ContractCreationItem>(sourceUrl);
  if (!fetched.result) {
    return {
      deployerAddress: null,
      creationTxHash: null,
      sourceUrl,
      error: fetched.error,
    };
  }

  const first = fetched.result[0] ?? {};
  return {
    deployerAddress:
      typeof first.contractCreator === "string" && first.contractCreator.startsWith("0x")
        ? first.contractCreator.toLowerCase()
        : null,
    creationTxHash:
      typeof first.txHash === "string" && first.txHash.startsWith("0x") ? first.txHash.toLowerCase() : null,
    sourceUrl,
    error: fetched.error,
  };
}

export async function getBaseContractVerification(address: string): Promise<VerificationResult> {
  const sourceInfo = await getBaseContractSourceInfo(address);
  return {
    isVerified: sourceInfo.isVerified,
    sourceUrl: sourceInfo.sourceUrl,
    error: sourceInfo.error,
  };
}
