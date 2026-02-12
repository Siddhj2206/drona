import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listScanEventsAfter } from "@/lib/db/scan-events";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ scanId: string }> }) {
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

  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? "0");
  const cursor = Number.isFinite(after) && after > 0 ? after : 0;
  const events = await listScanEventsAfter(parsedScanId.data, cursor);
  const nextAfter = events.length > 0 ? events[events.length - 1].id : cursor;

  return NextResponse.json({
    scanId: parsedScanId.data,
    status: scan.status,
    events,
    nextAfter,
  });
}
