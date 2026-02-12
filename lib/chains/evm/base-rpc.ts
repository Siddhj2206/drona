const DEFAULT_TIMEOUT_MS = 10_000;

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: number;
  result: T;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
};

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export async function baseRpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const rpcUrl = process.env.BASE_RPC_URL;

  if (!rpcUrl) {
    throw new Error("BASE_RPC_URL is not set");
  }

  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Base RPC request failed with ${response.status}`);
    }

    const json = (await response.json()) as unknown;

    if (typeof json !== "object" || json === null) {
      throw new Error("Base RPC response was not a valid JSON-RPC object");
    }

    const rpcResponse = json as JsonRpcResponse<T>;

    if ("error" in rpcResponse) {
      throw new Error(`Base RPC error (${rpcResponse.error.code}): ${rpcResponse.error.message}`);
    }

    return rpcResponse.result;
  } finally {
    clear();
  }
}

export async function getBytecode(address: string) {
  return baseRpcCall<string>("eth_getCode", [address, "latest"]);
}

export async function getContractCodeStatus(address: string) {
  const bytecode = await getBytecode(address);
  return {
    hasCode: bytecode !== "0x",
    bytecodeSizeBytes: bytecode === "0x" ? 0 : (bytecode.length - 2) / 2,
  };
}

function decodeStringResult(hex: string) {
  if (!hex || hex === "0x" || !hex.startsWith("0x")) {
    return null;
  }

  const raw = hex.slice(2);

  if (raw.length >= 128) {
    const offsetHex = raw.slice(0, 64);
    const lengthHex = raw.slice(64, 128);
    const offset = Number.parseInt(offsetHex, 16);
    const length = Number.parseInt(lengthHex, 16);

    if (Number.isFinite(offset) && Number.isFinite(length) && length >= 0) {
      const dataStart = 128;
      const dataEnd = dataStart + length * 2;
      const dataHex = raw.slice(dataStart, dataEnd);

      if (dataHex.length === length * 2) {
        const value = Buffer.from(dataHex, "hex").toString("utf8").replace(/\u0000+$/g, "").trim();
        return value.length > 0 ? value : null;
      }
    }
  }

  const value = Buffer.from(raw, "hex").toString("utf8").replace(/\u0000+$/g, "").trim();
  return value.length > 0 ? value : null;
}

function decodeUintResult(hex: string) {
  if (!hex || hex === "0x") {
    return null;
  }

  try {
    return BigInt(hex).toString();
  } catch {
    return null;
  }
}

type Erc20Metadata = {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
};

export async function getErc20Metadata(address: string): Promise<Erc20Metadata> {
  const call = async (data: string) =>
    baseRpcCall<string>("eth_call", [
      {
        to: address,
        data,
      },
      "latest",
    ]);

  const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.allSettled([
    call("0x06fdde03"),
    call("0x95d89b41"),
    call("0x313ce567"),
    call("0x18160ddd"),
  ]);

  const decimalsValue =
    decimalsHex.status === "fulfilled" && decimalsHex.value !== "0x"
      ? Number.parseInt(decimalsHex.value, 16)
      : Number.NaN;

  return {
    name: nameHex.status === "fulfilled" ? decodeStringResult(nameHex.value) : null,
    symbol: symbolHex.status === "fulfilled" ? decodeStringResult(symbolHex.value) : null,
    decimals: Number.isFinite(decimalsValue) ? decimalsValue : null,
    totalSupply: totalSupplyHex.status === "fulfilled" ? decodeUintResult(totalSupplyHex.value) : null,
  };
}
