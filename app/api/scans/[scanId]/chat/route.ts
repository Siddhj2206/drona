import { generateText } from "ai";
import { createCerebras } from "@ai-sdk/cerebras";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";

export const runtime = "nodejs";

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 800;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_PROMPT_CHARS = 30_000;

type ChatMessage = z.infer<typeof chatBodySchema>["messages"][number];

function truncateText(input: string, maxChars: number) {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxChars - 1))}...`;
}

function normalizeMessages(messages: ChatMessage[]) {
  return messages.slice(-MAX_MESSAGES).map((message) => ({
    role: message.role,
    content: truncateText(message.content.trim(), MAX_MESSAGE_CHARS),
  }));
}

function summarizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateText(value, 180);
  }
  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `array(${value.length})`;
    }
    return value.slice(0, 5).map((entry) => summarizeUnknown(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "object";
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
    return Object.fromEntries(entries.map(([key, entry]) => [key, summarizeUnknown(entry, depth + 1)]));
  }
  return String(value);
}

function getToolPriority(queryText: string) {
  const text = queryText.toLowerCase();
  const priorities = new Set<string>();

  if (/(honeypot|sell|tax|swap)/.test(text)) {
    priorities.add("honeypot_getSimulation");
  }
  if (/(liquidity|lp|lock|burn)/.test(text)) {
    priorities.add("lp_v2_lockStatus");
    priorities.add("dexscreener_getPairs");
  }
  if (/(holder|whale|distribution|top\s*5|top\s*10|pump|dump)/.test(text)) {
    priorities.add("holders_getTopHolders");
  }
  if (/(owner|mint|admin|pause|blacklist|proxy|verified|source|creator|deployer)/.test(text)) {
    priorities.add("contract_ownerStatus");
    priorities.add("contract_capabilityScan");
    priorities.add("basescan_getSourceInfo");
    priorities.add("basescan_getContractCreation");
  }

  priorities.add("rpc_getErc20Metadata");
  priorities.add("rpc_getBytecode");
  return priorities;
}

function buildEvidenceSnapshot(evidence: unknown, score: unknown, messages: ChatMessage[]) {
  const evidenceRecord = evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>) : {};
  const rawItems = Array.isArray(evidenceRecord.items) ? evidenceRecord.items : [];
  const lastUserQuery = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const preferredTools = getToolPriority(lastUserQuery);

  const normalizedItems = rawItems
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : null,
      tool: typeof item.tool === "string" ? item.tool : null,
      title: typeof item.title === "string" ? item.title : null,
      status: typeof item.status === "string" ? item.status : null,
      sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : null,
      error: typeof item.error === "string" ? item.error : null,
      fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
      data: summarizeUnknown(item.data ?? null),
    }));

  const selected = normalizedItems
    .sort((a, b) => {
      const aPreferred = a.tool !== null && preferredTools.has(a.tool);
      const bPreferred = b.tool !== null && preferredTools.has(b.tool);
      if (aPreferred !== bPreferred) {
        return aPreferred ? -1 : 1;
      }
      if (a.status !== b.status) {
        return a.status === "ok" ? -1 : 1;
      }
      return 0;
    })
    .slice(0, MAX_EVIDENCE_ITEMS);

  return {
    scanScore: summarizeUnknown(score),
    meta: summarizeUnknown(evidenceRecord.meta ?? null),
    trace: summarizeUnknown(evidenceRecord.trace ?? null),
    items: selected,
    excludedItemCount: Math.max(0, normalizedItems.length - selected.length),
  };
}

export async function POST(request: Request, context: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await context.params;
  const parsedScanId = z.string().uuid().safeParse(scanId);

  if (!parsedScanId.success) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = chatBodySchema.safeParse(body);

  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request body", details: parsedBody.error.flatten() }, { status: 400 });
  }

  const scan = await db.query.scans.findFirst({
    where: eq(scans.id, parsedScanId.data),
  });

  if (!scan) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const apiKey = process.env.CEREBRAS_API_KEY;
  const modelId = process.env.CEREBRAS_MODEL ?? "llama-3.3-70b";

  if (!apiKey) {
    return NextResponse.json({ error: "CEREBRAS_API_KEY is not set" }, { status: 500 });
  }

  const cerebras = createCerebras({ apiKey });
  const normalizedMessages = normalizeMessages(parsedBody.data.messages);
  const conversation = normalizedMessages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  const evidenceSnapshot = buildEvidenceSnapshot(scan.evidence, scan.score, normalizedMessages);
  let evidenceJson = JSON.stringify(evidenceSnapshot);

  if (evidenceJson.length > MAX_PROMPT_CHARS) {
    evidenceJson = JSON.stringify({
      ...evidenceSnapshot,
      trace: null,
      items: evidenceSnapshot.items.map((item) => ({
        id: item.id,
        tool: item.tool,
        title: item.title,
        status: item.status,
        sourceUrl: item.sourceUrl,
        error: item.error,
        fetchedAt: item.fetchedAt,
      })),
      note: "Evidence payload was trimmed for token budget.",
    });
  }

  const result = await generateText({
    model: cerebras(modelId),
    temperature: 0,
    maxOutputTokens: 500,
    system:
      "You are Drona assistant. Answer strictly from the provided evidence snapshot. If data is missing, say unknown and mention which tool result is needed. Do not invent hashes, balances, holder stats, or ownership facts. Always cite the relevant evidence ids when available.",
    prompt: `EVIDENCE SNAPSHOT JSON:\n${evidenceJson}\n\nCONVERSATION:\n${conversation}\n\nReturn a concise answer grounded in evidence.`,
  });

  return NextResponse.json({ message: result.text });
}
