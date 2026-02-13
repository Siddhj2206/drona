import { and, asc, desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { scanJobs } from "@/lib/db/schema";

export type ScanJobStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export async function enqueueScanJob(scanId: string) {
  const existing = await db.query.scanJobs.findFirst({
    where: and(
      eq(scanJobs.scanId, scanId),
      or(eq(scanJobs.status, "pending"), eq(scanJobs.status, "running")),
    ),
    orderBy: [desc(scanJobs.createdAt)],
  });

  if (existing) {
    return {
      enqueued: false,
      jobId: existing.id,
      status: existing.status as ScanJobStatus,
    };
  }

  const [job] = await db
    .insert(scanJobs)
    .values({
      scanId,
      status: "pending",
    })
    .returning({ id: scanJobs.id, status: scanJobs.status });

  return {
    enqueued: true,
    jobId: job.id,
    status: job.status as ScanJobStatus,
  };
}

export async function claimNextPendingScanJob() {
  while (true) {
    const pending = await db.query.scanJobs.findFirst({
      where: eq(scanJobs.status, "pending"),
      orderBy: [asc(scanJobs.createdAt)],
    });

    if (!pending) {
      return null;
    }

    const nextAttempt = pending.attempt + 1;
    const [claimed] = await db
      .update(scanJobs)
      .set({
        status: "running",
        startedAt: new Date(),
        finishedAt: null,
        error: null,
        attempt: nextAttempt,
      })
      .where(and(eq(scanJobs.id, pending.id), eq(scanJobs.status, "pending")))
      .returning();

    if (claimed) {
      return claimed;
    }
  }
}

export async function finalizeScanJob(jobId: string, status: Exclude<ScanJobStatus, "pending" | "running">, error: string | null) {
  await db
    .update(scanJobs)
    .set({
      status,
      finishedAt: new Date(),
      error,
    })
    .where(eq(scanJobs.id, jobId));
}
