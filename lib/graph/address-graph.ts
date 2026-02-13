export type GraphEvidenceItem = {
  id?: string;
  tool: string;
  status: "ok" | "unavailable" | string;
  data?: Record<string, unknown>;
};

export type AddressGraphNodeKind = "token" | "deployer" | "owner" | "implementation" | "pair" | "holder" | "contract" | "wallet";

export type AddressGraphNode = {
  id: string;
  label: string;
  kind: AddressGraphNodeKind;
  weight: number;
  meta?: string;
};

export type AddressGraphLink = {
  source: string;
  target: string;
  label: string;
  weight: number;
  approximate?: boolean;
};

export type AddressGraphData = {
  nodes: AddressGraphNode[];
  links: AddressGraphLink[];
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_REGEX.test(value);
}

function normalizeAddress(value: string) {
  return value.toLowerCase();
}

function shorten(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getItem(items: GraphEvidenceItem[], tool: string) {
  return items.find((item) => item.tool === tool && item.status === "ok");
}

export function buildAddressGraphData(tokenAddress: string, evidenceItems: GraphEvidenceItem[]): AddressGraphData {
  const nodes = new Map<string, AddressGraphNode>();
  const links = new Map<string, AddressGraphLink>();

  const addNode = (address: string, kind: AddressGraphNodeKind, weight = 1, meta?: string) => {
    const id = normalizeAddress(address);
    const current = nodes.get(id);

    if (!current) {
      nodes.set(id, {
        id,
        label: shorten(id),
        kind,
        weight,
        meta,
      });
      return;
    }

    if (weight > current.weight) {
      current.weight = weight;
    }

    if (current.kind === "wallet" && kind !== "wallet") {
      current.kind = kind;
    }

    if (!current.meta && meta) {
      current.meta = meta;
    }
  };

  const addLink = (sourceAddress: string, targetAddress: string, label: string, weight = 1, approximate = false) => {
    const source = normalizeAddress(sourceAddress);
    const target = normalizeAddress(targetAddress);
    const key = `${source}|${target}|${label}`;
    const current = links.get(key);

    if (!current) {
      links.set(key, { source, target, label, weight, approximate });
      return;
    }

    if (weight > current.weight) {
      current.weight = weight;
    }
    current.approximate = current.approximate || approximate;
  };

  if (isAddress(tokenAddress)) {
    addNode(tokenAddress, "token", 1.8, "Token contract");
  }

  const creation = getItem(evidenceItems, "basescan_getContractCreation");
  const deployerAddress = creation?.data?.deployerAddress;
  if (isAddress(deployerAddress) && isAddress(tokenAddress)) {
    addNode(deployerAddress, "deployer", 1.2, "Contract deployer");
    addLink(deployerAddress, tokenAddress, "DEPLOYED", 1.4);
  }

  const ownerStatus = getItem(evidenceItems, "contract_ownerStatus");
  const ownerAddress = ownerStatus?.data?.ownerAddress;
  if (isAddress(ownerAddress) && isAddress(tokenAddress)) {
    const renounced = ownerStatus?.data?.renounced === true;
    addNode(ownerAddress, "owner", 1.2, renounced ? "Owner (renounced signal)" : "Owner");
    addLink(ownerAddress, tokenAddress, "OWNS", 1.3);
  }

  const sourceInfo = getItem(evidenceItems, "basescan_getSourceInfo");
  const implementationAddress = sourceInfo?.data?.implementationAddress;
  if (isAddress(implementationAddress) && isAddress(tokenAddress)) {
    addNode(implementationAddress, "implementation", 1.1, "Proxy implementation");
    addLink(implementationAddress, tokenAddress, "IMPLEMENTS", 1.1);
  }

  const dex = getItem(evidenceItems, "dexscreener_getPairs");
  const dexPairsRaw = Array.isArray(dex?.data?.pairs) ? dex?.data?.pairs : [];
  const dexPairs = dexPairsRaw
    .map((pair) => {
      if (!pair || typeof pair !== "object") return null;
      const candidate = pair as { pairAddress?: unknown; dex?: unknown; liquidityUsd?: unknown };
      if (!isAddress(candidate.pairAddress)) return null;
      return {
        pairAddress: candidate.pairAddress,
        dex: typeof candidate.dex === "string" ? candidate.dex : null,
        liquidityUsd: toNumber(candidate.liquidityUsd),
      };
    })
    .filter((pair): pair is { pairAddress: string; dex: string | null; liquidityUsd: number | null } => pair !== null)
    .slice(0, 3);

  for (const pair of dexPairs) {
    addNode(pair.pairAddress, "pair", 1.1, pair.dex ? `DEX pair (${pair.dex})` : "DEX pair");
    if (isAddress(tokenAddress)) {
      const linkWeight = pair.liquidityUsd !== null ? Math.min(2, 1 + pair.liquidityUsd / 1_000_000) : 1;
      addLink(tokenAddress, pair.pairAddress, "TRADES", linkWeight);
    }
  }

  const lpLock = getItem(evidenceItems, "lp_v2_lockStatus");
  const lpPairAddress = lpLock?.data?.pairAddress;
  if (isAddress(lpPairAddress) && isAddress(tokenAddress)) {
    addNode(lpPairAddress, "pair", 1.15, "LP pair");
    addLink(tokenAddress, lpPairAddress, "LP", 1.2);
  }

  const honeypot = getItem(evidenceItems, "honeypot_getSimulation");
  const honeypotPairAddress = honeypot?.data?.pairAddress;
  if (isAddress(honeypotPairAddress) && isAddress(tokenAddress)) {
    addNode(honeypotPairAddress, "pair", 1.05, "Swap simulation pair");
    addLink(tokenAddress, honeypotPairAddress, "SIM_PAIR", 1.05);
  }

  const holders = getItem(evidenceItems, "holders_getTopHolders");
  const method = typeof holders?.data?.method === "string" ? holders.data.method : null;
  const rowsRaw =
    Array.isArray(holders?.data?.top10) && holders?.data?.top10.length > 0
      ? holders.data.top10
      : Array.isArray(holders?.data?.topHolders)
        ? holders.data.topHolders
        : [];

  for (const row of rowsRaw.slice(0, 10)) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as {
      address?: unknown;
      isContract?: unknown;
      pctOfSupply?: unknown;
      relativeSharePct?: unknown;
    };

    if (!isAddress(candidate.address) || !isAddress(tokenAddress)) continue;

    const pctOfSupply = toNumber(candidate.pctOfSupply);
    const relativeSharePct = toNumber(candidate.relativeSharePct);
    const isContract = candidate.isContract === true;
    const nodeWeight = pctOfSupply !== null ? Math.min(4, 1 + pctOfSupply / 10) : 1.15;

    addNode(
      candidate.address,
      isContract ? "contract" : "holder",
      nodeWeight,
      pctOfSupply !== null ? `${pctOfSupply.toFixed(2)}% supply` : "Holder",
    );

    const edgeLabel =
      pctOfSupply !== null
        ? `HOLDS ${pctOfSupply.toFixed(2)}%`
        : relativeSharePct !== null
          ? `HOLDS ~${relativeSharePct.toFixed(2)}%`
          : "HOLDS";

    addLink(
      candidate.address,
      tokenAddress,
      edgeLabel,
      pctOfSupply !== null ? Math.min(3.5, 1 + pctOfSupply / 12) : 1.1,
      pctOfSupply === null || method === "balance_updates",
    );
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()],
  };
}
