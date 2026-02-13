import { baseRpcCall } from "@/lib/chains/evm/base-rpc";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ERC20_TOTAL_SUPPLY = "0x18160ddd";
const ERC20_BALANCE_OF = "0x70a08231";
const V2_GET_RESERVES = "0x0902f1ac";

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function encodeAddressParam(address: string) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function callPairMethod(to: string, data: string) {
  return baseRpcCall<string>("eth_call", [
    {
      to,
      data,
    },
    "latest",
  ]);
}

async function readUintCall(to: string, data: string): Promise<bigint | null> {
  try {
    const hex = await callPairMethod(to, data);
    if (!hex || hex === "0x") {
      return null;
    }
    return BigInt(hex);
  } catch {
    return null;
  }
}

async function isLikelyV2Pair(pairAddress: string): Promise<boolean> {
  try {
    const reservesHex = await callPairMethod(pairAddress, V2_GET_RESERVES);
    return typeof reservesHex === "string" && reservesHex.startsWith("0x") && reservesHex.length >= 194;
  } catch {
    return false;
  }
}

function toPct(numerator: bigint, denominator: bigint | null) {
  if (denominator === null || denominator <= BigInt(0)) {
    return null;
  }

  return Number(((numerator * BigInt(10000)) / denominator).toString()) / 100;
}

export type LpLockStatusResult = {
  pairAddress: string;
  isV2Pair: boolean;
  totalSupply: string | null;
  balances: {
    zeroAddress: string | null;
    deadAddress: string | null;
    deployerAddress: string | null;
    deployerBalance: string | null;
  };
  computed: {
    burnedPct: number | null;
    deployerPct: number | null;
  };
  lockStatus: "locked" | "unlocked" | "unknown";
  confidence: "low" | "medium" | "high";
  reason: string;
};

export async function getV2LpLockStatus(pairAddress: string, deployerAddress: string | null): Promise<LpLockStatusResult> {
  const pair = normalizeAddress(pairAddress);
  const deployer = deployerAddress ? normalizeAddress(deployerAddress) : null;
  const v2Pair = await isLikelyV2Pair(pair);

  if (!v2Pair) {
    return {
      pairAddress: pair,
      isV2Pair: false,
      totalSupply: null,
      balances: {
        zeroAddress: null,
        deadAddress: null,
        deployerAddress: deployer,
        deployerBalance: null,
      },
      computed: {
        burnedPct: null,
        deployerPct: null,
      },
      lockStatus: "unknown",
      confidence: "low",
      reason: "Primary pair is not detected as a V2-style LP token pair",
    };
  }

  const [totalSupply, zeroBalance, deadBalance, deployerBalance] = await Promise.all([
    readUintCall(pair, ERC20_TOTAL_SUPPLY),
    readUintCall(pair, `${ERC20_BALANCE_OF}${encodeAddressParam(ZERO_ADDRESS)}`),
    readUintCall(pair, `${ERC20_BALANCE_OF}${encodeAddressParam(DEAD_ADDRESS)}`),
    deployer ? readUintCall(pair, `${ERC20_BALANCE_OF}${encodeAddressParam(deployer)}`) : Promise.resolve(null),
  ]);

  const burned = (zeroBalance ?? BigInt(0)) + (deadBalance ?? BigInt(0));
  const burnedPct = toPct(burned, totalSupply);
  const deployerPct = toPct(deployerBalance ?? BigInt(0), totalSupply);

  let lockStatus: LpLockStatusResult["lockStatus"] = "unknown";
  let confidence: LpLockStatusResult["confidence"] = "low";
  let reason = "Insufficient LP evidence to prove lock status";

  if (burnedPct !== null && burnedPct >= 95) {
    lockStatus = "locked";
    confidence = "high";
    reason = `At least 95% of LP appears burned (${burnedPct.toFixed(2)}%)`;
  } else if (deployerPct !== null && deployerPct >= 20) {
    lockStatus = "unlocked";
    confidence = "medium";
    reason = `Deployer retains a large LP share (${deployerPct.toFixed(2)}%)`;
  }

  return {
    pairAddress: pair,
    isV2Pair: true,
    totalSupply: totalSupply?.toString() ?? null,
    balances: {
      zeroAddress: zeroBalance?.toString() ?? null,
      deadAddress: deadBalance?.toString() ?? null,
      deployerAddress: deployer,
      deployerBalance: deployerBalance?.toString() ?? null,
    },
    computed: {
      burnedPct,
      deployerPct,
    },
    lockStatus,
    confidence,
    reason,
  };
}
