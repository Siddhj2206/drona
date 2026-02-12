import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import { LiveProgress } from "./live-progress";
import { ReportView } from "@/components/scan/report-view";

export const runtime = "nodejs";

type ScanReportPageProps = {
  params: Promise<{
    scanId: string;
  }>;
};

export default async function ScanReportPage({ params }: ScanReportPageProps) {
  const { scanId } = await params;
  const parsedScanId = z.string().uuid().safeParse(scanId);

  if (!parsedScanId.success) {
    notFound();
  }

  const scan = await db.query.scans.findFirst({
    where: eq(scans.id, parsedScanId.data),
  });

  if (!scan) {
    notFound();
  }

  if (scan.status === "queued" || scan.status === "running") {
    return <LiveProgress scanId={scan.id} initialStatus={scan.status} />;
  }

  return (
    <ReportView
      scanId={scan.id}
      tokenAddress={scan.tokenAddress}
      status={scan.status}
      createdAtIso={scan.createdAt.toISOString()}
      narrative={scan.narrative}
      score={scan.score}
      evidence={scan.evidence}
      error={scan.error}
    />
  );
}
