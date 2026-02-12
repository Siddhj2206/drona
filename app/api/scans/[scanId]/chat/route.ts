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
  const conversation = parsedBody.data.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  const evidenceJson = JSON.stringify(scan.evidence ?? {}, null, 2);

  const result = await generateText({
    model: cerebras(modelId),
    temperature: 0,
    maxOutputTokens: 500,
    system:
      "You are Drona assistant. You must answer strictly from the provided evidence JSON. If data is missing, say it is unknown and suggest which check/tool result is needed. Do not invent transaction hashes, balances, or holder data.",
    prompt: `EVIDENCE JSON:\n${evidenceJson}\n\nCONVERSATION:\n${conversation}\n\nReturn a concise answer and reference relevant evidence ids where possible.`,
  });

  return NextResponse.json({ message: result.text });
}
