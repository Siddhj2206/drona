import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ scanId: string }> },
) {
  const { scanId } = await context.params;
  const parsedScanId = z.string().uuid().safeParse(scanId);

  if (!parsedScanId.success) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const scan = await db.query.scans.findFirst({
    where: eq(scans.id, parsedScanId.data),
  });

  if (!scan) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: scan.id,
    chain: scan.chain,
    tokenAddress: scan.tokenAddress,
    status: scan.status,
    createdAt: scan.createdAt,
    durationMs: scan.durationMs,
    scannerVersion: scan.scannerVersion,
    scoreVersion: scan.scoreVersion,
    evidence: scan.evidence,
    score: scan.score,
    narrative: scan.narrative,
    model: scan.model,
    error: scan.error,
  });
}
