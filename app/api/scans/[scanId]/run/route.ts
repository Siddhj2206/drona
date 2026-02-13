import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueScanJob } from "@/lib/db/scan-jobs";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import { triggerScanJobWorker } from "@/lib/scanner/scan-job-worker";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ scanId: string }> },
) {
  const { scanId } = await context.params;
  const parsedScanId = z.string().uuid().safeParse(scanId);
  if (!parsedScanId.success) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const id = parsedScanId.data;
  const existing = await db.query.scans.findFirst({
    where: eq(scans.id, id),
  });

  if (!existing) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  if (existing.status === "complete" || existing.status === "failed") {
    return NextResponse.json({ scanId: id, status: existing.status, skipped: true }, { status: 200 });
  }

  const job = await enqueueScanJob(id);
  void triggerScanJobWorker();

  return NextResponse.json(
    {
      scanId: id,
      status: existing.status,
      enqueued: job.enqueued,
      jobId: job.jobId,
      jobStatus: job.status,
    },
    { status: 202 },
  );
}
