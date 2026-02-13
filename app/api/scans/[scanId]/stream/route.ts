import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listScanEventsAfter } from "@/lib/db/scan-events";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = new Set(["complete", "failed", "canceled"]);
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed"]);
const POLL_INTERVAL_MS = 1200;
const STATUS_CHECK_EVERY_LOOPS = 4;
const HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_RETRY_MS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request, context: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await context.params;
  const parsedScanId = z.string().uuid().safeParse(scanId);

  if (!parsedScanId.success) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const id = parsedScanId.data;
  const scan = await db.query.scans.findFirst({
    where: eq(scans.id, id),
  });

  if (!scan) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const afterFromQuery = Number(url.searchParams.get("after") ?? "0");
  const afterFromHeader = Number(request.headers.get("last-event-id") ?? "0");
  const queryCursor = Number.isFinite(afterFromQuery) && afterFromQuery > 0 ? afterFromQuery : 0;
  let cursor = Number.isFinite(afterFromHeader) && afterFromHeader > 0 ? afterFromHeader : queryCursor;
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const push = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };

      const pushEvent = (event: Awaited<ReturnType<typeof listScanEventsAfter>>[number]) => {
        cursor = event.id;
        push(`id: ${event.id}\n`);
        push(`event: ${event.type}\n`);
        push(
          `data: ${JSON.stringify({
            id: event.id,
            seq: event.seq,
            ts: event.ts,
            level: event.level,
            type: event.type,
            stepKey: event.stepKey,
            message: event.message,
            payload: event.payload,
          })}\n\n`,
        );
      };

      push(`retry: ${SSE_RETRY_MS}\n\n`);
      push(`event: ready\ndata: ${JSON.stringify({ scanId: id, cursor })}\n\n`);
      let sawTerminalEvent = false;
      let loopCount = 0;
      let lastHeartbeatAt = Date.now();

      while (!cancelled) {
        loopCount += 1;
        const events = await listScanEventsAfter(id, cursor);

        for (const event of events) {
          pushEvent(event);

          if (TERMINAL_EVENT_TYPES.has(event.type)) {
            sawTerminalEvent = true;
          }
        }

        if (sawTerminalEvent) {
          push("event: end\ndata: {}\n\n");
          controller.close();
          return;
        }

        if (cancelled) {
          return;
        }

        if (events.length === 0) {
          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            push(`: heartbeat ${now}\n\n`);
            lastHeartbeatAt = now;
          }

          if (loopCount % STATUS_CHECK_EVERY_LOOPS === 0) {
            const latestScan = await db.query.scans.findFirst({
              where: eq(scans.id, id),
            });

            if (!latestScan || TERMINAL_STATUSES.has(latestScan.status)) {
              const trailingEvents = await listScanEventsAfter(id, cursor);
              for (const event of trailingEvents) {
                pushEvent(event);
              }

              push("event: end\ndata: {}\n\n");
              controller.close();
              return;
            }
          }
        }

        await sleep(POLL_INTERVAL_MS);
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
