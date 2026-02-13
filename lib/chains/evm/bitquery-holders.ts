const DEFAULT_BITQUERY_ENDPOINT = "https://streaming.bitquery.io/graphql";
const DEFAULT_TIMEOUT_MS = 10_000;

const FAST_PROBE_DAYS = [1, 2, 7];
const FULL_PROBE_DAYS = [1, 2, 3, 7, 14, 30];

type HoldersMode = "off" | "fast" | "full";

type BitqueryHoldersResult = {
  asOfDate: string;
  attemptedDates: string[];
  sourceUrl: string;
  method: "token_holders" | "balance_updates";
  holders: Array<{
    address: string;
    amount: string;
  }>;
};

type TokenHoldersResponse = {
  data?: {
    EVM?: {
      TokenHolders?: Array<{
        Holder?: {
          Address?: string;
        };
        Balance?: {
          Amount?: string;
        };
      }>;
    };
  };
  errors?: Array<{
    message?: string;
  }>;
};

function toDateDaysAgo(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getHoldersMode(): HoldersMode {
  const raw = process.env.BITQUERY_HOLDERS_MODE?.toLowerCase();
  if (raw === "off" || raw === "fast" || raw === "full") {
    return raw;
  }
  return "fast";
}

function getProbeDays(mode: HoldersMode) {
  if (mode === "full") {
    return FULL_PROBE_DAYS;
  }
  if (mode === "fast") {
    return FAST_PROBE_DAYS;
  }
  return [];
}

function isCreditsOrRateLimitStatus(status: number) {
  return status === 402 || status === 429;
}

function hasQuotaError(errors: Array<{ message?: string }> | undefined) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return false;
  }

  return errors.some((error) => {
    const message = (error.message ?? "").toLowerCase();
    return (
      message.includes("credit") ||
      message.includes("rate limit") ||
      message.includes("too many") ||
      message.includes("quota")
    );
  });
}

const TOKEN_HOLDERS_QUERY = `
  query TokenHoldersTop($token: String!, $date: String!, $limit: Int!) {
    EVM(network: base, dataset: archive) {
      TokenHolders(
        tokenSmartContract: $token
        date: $date
        where: {
          Balance: { Amount: { gt: "0" } }
          BalanceUpdate: { FirstDate: { is: $date } }
        }
        limit: { count: $limit }
        orderBy: { descendingByField: "Balance_Amount" }
      ) {
        Holder { Address }
        Balance { Amount }
      }
    }
  }
`;

const BALANCE_UPDATES_QUERY = `
  query TopHoldersFallback($token: String!, $limit: Int!) {
    EVM(network: base) {
      BalanceUpdates(
        where: { Currency: { SmartContract: { is: $token } } }
        orderBy: { descendingByField: "balance" }
        limit: { count: $limit }
      ) {
        BalanceUpdate {
          Address
        }
        balance: sum(of: BalanceUpdate_AmountInUSD, selectWhere: { ne: "0" })
      }
    }
  }
`;

export async function getTopHoldersFromBitquery(
  tokenAddress: string,
  limit = 10,
): Promise<BitqueryHoldersResult> {
  const accessToken = process.env.BITQUERY_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error("BITQUERY_ACCESS_TOKEN is not set");
  }

  const endpoint = process.env.BITQUERY_ENDPOINT ?? DEFAULT_BITQUERY_ENDPOINT;
  const mode = getHoldersMode();
  if (mode === "off") {
    throw new Error("Bitquery holders lookup is disabled by BITQUERY_HOLDERS_MODE=off");
  }

  const probeDays = getProbeDays(mode);
  const maxAttempts = parsePositiveInt(process.env.BITQUERY_MAX_ARCHIVE_ATTEMPTS, probeDays.length);
  const minRows = parsePositiveInt(process.env.BITQUERY_MIN_HOLDER_ROWS, 3);
  const attemptedDates: string[] = [];
  const token = tokenAddress.toLowerCase();
  let lastError = "No holder data returned";
  const minimumRows = Math.max(1, Math.min(limit, minRows));
  let shouldRunFallback = true;

  for (const daysAgo of probeDays.slice(0, maxAttempts)) {
    const date = toDateDaysAgo(daysAgo);
    attemptedDates.push(date);
    const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: TOKEN_HOLDERS_QUERY,
          variables: {
            token,
            date,
            limit,
          },
        }),
        signal,
        cache: "no-store",
      });

      if (!response.ok) {
        lastError = `Bitquery request failed with ${response.status}`;
        if (isCreditsOrRateLimitStatus(response.status)) {
          shouldRunFallback = false;
          break;
        }
        continue;
      }

      const json = (await response.json()) as TokenHoldersResponse;

      if (Array.isArray(json.errors) && json.errors.length > 0) {
        lastError = json.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ");
        if (hasQuotaError(json.errors)) {
          shouldRunFallback = false;
          break;
        }
        continue;
      }

      const rows = json.data?.EVM?.TokenHolders ?? [];

      const holders = rows
        .map((row) => ({
          address: row.Holder?.Address?.toLowerCase() ?? "",
          amount: row.Balance?.Amount ?? "0",
        }))
        .filter((holder) => holder.address.length > 0 && holder.amount !== "0");

      if (holders.length < minimumRows) {
        lastError = `Bitquery returned ${holders.length} holder rows for ${date}`;
        continue;
      }

      return {
        asOfDate: date,
        attemptedDates,
        sourceUrl: endpoint,
        method: "token_holders",
        holders,
      };
    } finally {
      clear();
    }
  }

  if (!shouldRunFallback) {
    throw new Error(lastError);
  }

  {
    const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);

    try {
      const fallbackResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: BALANCE_UPDATES_QUERY,
          variables: {
            token,
            limit,
          },
        }),
        signal,
        cache: "no-store",
      });

      if (fallbackResponse.ok) {
        const fallbackJson = (await fallbackResponse.json()) as {
          data?: {
            EVM?: {
              BalanceUpdates?: Array<{
                BalanceUpdate?: { Address?: string };
                balance?: string | number;
              }>;
            };
          };
          errors?: Array<{ message?: string }>;
        };

        if (Array.isArray(fallbackJson.errors) && fallbackJson.errors.length > 0) {
          lastError = fallbackJson.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ");
        } else {
          const fallbackRows = fallbackJson.data?.EVM?.BalanceUpdates ?? [];
          const fallbackHolders = fallbackRows
            .map((row) => ({
              address: row.BalanceUpdate?.Address?.toLowerCase() ?? "",
              amount: String(row.balance ?? "0"),
            }))
            .filter((holder) => holder.address.length > 0 && holder.amount !== "0");

          if (fallbackHolders.length >= minimumRows) {
            return {
              asOfDate: attemptedDates[attemptedDates.length - 1] ?? toDateDaysAgo(1),
              attemptedDates,
              sourceUrl: endpoint,
              method: "balance_updates",
              holders: fallbackHolders,
            };
          }

          lastError = `Bitquery fallback returned ${fallbackHolders.length} holder rows`;
        }
      } else {
        lastError = `Bitquery fallback request failed with ${fallbackResponse.status}`;
        if (isCreditsOrRateLimitStatus(fallbackResponse.status)) {
          throw new Error(lastError);
        }
      }
    } finally {
      clear();
    }
  }

  throw new Error(lastError);
}
