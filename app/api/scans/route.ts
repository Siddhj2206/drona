import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { enqueueScanJob } from "@/lib/db/scan-jobs";
import { getContractCodeStatus } from "@/lib/chains/evm/base-rpc";
import { scans } from "@/lib/db/schema";
import { triggerScanJobWorker } from "@/lib/scanner/scan-job-worker";

export const runtime = "nodejs";

const createScanSchema = z.object({
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid token address"),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createScanSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const tokenAddress = parsed.data.tokenAddress.toLowerCase();
  const preflight = await getContractCodeStatus(tokenAddress);

  if (!preflight.hasCode) {
    return NextResponse.json(
      {
        error:
          "This address has no contract code on Base. Use a Base token contract address (not a wallet address).",
      },
      { status: 400 },
    );
  }

  const cacheTtlSeconds = Number(process.env.SCAN_CACHE_TTL_SECONDS ?? "900");
  const cacheTtlMs = Number.isFinite(cacheTtlSeconds) && cacheTtlSeconds > 0 ? cacheTtlSeconds * 1000 : 900_000;

  const [recentScan] = await db
    .select({ id: scans.id, createdAt: scans.createdAt })
    .from(scans)
    .where(and(eq(scans.chain, "base"), eq(scans.tokenAddress, tokenAddress), eq(scans.status, "complete")))
    .orderBy(desc(scans.createdAt))
    .limit(1);

  if (recentScan) {
    const ageMs = Date.now() - recentScan.createdAt.getTime();

    if (ageMs <= cacheTtlMs) {
      return NextResponse.json({ scanId: recentScan.id, status: "complete", cached: true }, { status: 200 });
    }
  }

  const scanId = crypto.randomUUID();

  await db.insert(scans).values({
    id: scanId,
    chain: "base",
    tokenAddress,
    status: "queued",
    durationMs: null,
    scannerVersion: "v1-agent",
    scoreVersion: "v1-agent",
    evidence: null,
    score: null,
    narrative: null,
    model: null,
    error: null,
  });

  await enqueueScanJob(scanId);
  void triggerScanJobWorker();

  return NextResponse.json({ scanId, status: "queued", cached: false }, { status: 201 });
}
