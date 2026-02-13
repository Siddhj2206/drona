import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { scanEvents, scans } from "@/lib/db/schema";

export type ScanEventLevel = "info" | "success" | "warning" | "error";

export type AppendScanEventInput = {
  scanId: string;
  level: ScanEventLevel;
  type: string;
  message: string;
  stepKey?: string | null;
  payload?: Record<string, unknown> | null;
};

export async function appendScanEvent(input: AppendScanEventInput) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select ${scans.id} from ${scans} where ${scans.id} = ${input.scanId} for update`);

    const [last] = await tx
      .select({ maxSeq: max(scanEvents.seq) })
      .from(scanEvents)
      .where(eq(scanEvents.scanId, input.scanId));

    const nextSeq = (last?.maxSeq ?? 0) + 1;

    const [event] = await tx
      .insert(scanEvents)
      .values({
        scanId: input.scanId,
        seq: nextSeq,
        level: input.level,
        type: input.type,
        stepKey: input.stepKey ?? null,
        message: input.message,
        payload: input.payload ?? null,
      })
      .returning();

    return event;
  });
}

export async function listScanEventsAfter(scanId: string, afterId: number) {
  return db.query.scanEvents.findMany({
    where: and(eq(scanEvents.scanId, scanId), gt(scanEvents.id, afterId)),
    orderBy: [asc(scanEvents.id)],
  });
}

export async function listScanEvents(scanId: string) {
  return db.query.scanEvents.findMany({
    where: eq(scanEvents.scanId, scanId),
    orderBy: [asc(scanEvents.id)],
  });
}

export async function getLatestScanEvent(scanId: string) {
  return db.query.scanEvents.findFirst({
    where: eq(scanEvents.scanId, scanId),
    orderBy: [desc(scanEvents.id)],
  });
}
