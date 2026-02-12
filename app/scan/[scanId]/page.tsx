import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import { LiveProgress } from "./live-progress";

export const runtime = "nodejs";

type ScanReportPageProps = {
  params: Promise<{
    scanId: string;
  }>;
};

type ScoreReason = {
  title: string;
  detail: string;
  evidenceRefs: string[];
};

type AgentScore = {
  overallScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  reasons: ScoreReason[];
  missingData: string[];
};

type EvidenceItem = {
  id: string;
  tool: string;
  title: string;
  status: "ok" | "unavailable";
  fetchedAt: string;
  error: string | null;
};

function isAgentScore(value: unknown): value is AgentScore {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AgentScore>;
  return (
    typeof candidate.overallScore === "number" &&
    typeof candidate.riskLevel === "string" &&
    typeof candidate.confidence === "string" &&
    Array.isArray(candidate.reasons)
  );
}

function getEvidenceItems(value: unknown): EvidenceItem[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const maybeItems = (value as { items?: unknown }).items;

  if (!Array.isArray(maybeItems)) {
    return [];
  }

  return maybeItems.filter((item): item is EvidenceItem => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const candidate = item as Partial<EvidenceItem>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.tool === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.status === "string" &&
      typeof candidate.fetchedAt === "string"
    );
  });
}

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

  const agentScore = isAgentScore(scan.score) ? scan.score : null;
  const evidenceItems = getEvidenceItems(scan.evidence);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <LiveProgress scanId={scan.id} initialStatus={scan.status} />

      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">Scan Report</p>
        <h1 className="text-2xl font-semibold tracking-tight">{scan.tokenAddress}</h1>
        <p className="text-sm text-muted-foreground">
          Status: <span className="font-medium text-foreground">{scan.status}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Created: <span className="font-medium text-foreground">{scan.createdAt.toISOString()}</span>
        </p>
      </header>

      <section className="space-y-2 rounded-lg border bg-card p-4">
        <h2 className="text-lg font-medium">Narrative</h2>
        <p className="text-sm text-muted-foreground">{scan.narrative ?? "No narrative available yet."}</p>
      </section>

      {agentScore ? (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-lg font-medium">AI Assessment</h2>
          <p className="text-sm text-muted-foreground">
            Score: <span className="font-medium text-foreground">{agentScore.overallScore}/100</span> | Risk level:{" "}
            <span className="font-medium text-foreground">{agentScore.riskLevel}</span> | Confidence:{" "}
            <span className="font-medium text-foreground">{agentScore.confidence}</span>
          </p>

          <div className="space-y-2">
            <p className="text-sm font-medium">Reasons</p>
            {agentScore.reasons.map((reason) => (
              <div key={`${reason.title}-${reason.evidenceRefs.join(",")}`} className="rounded-md border p-3">
                <p className="text-sm font-medium">{reason.title}</p>
                <p className="text-sm text-muted-foreground">{reason.detail}</p>
                <p className="mt-1 text-xs text-muted-foreground">Evidence: {reason.evidenceRefs.join(", ")}</p>
              </div>
            ))}
          </div>

          {agentScore.missingData.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">Missing data</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {agentScore.missingData.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {scan.error ? (
        <section className="space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
          <h2 className="text-lg font-medium text-destructive">Scan Error</h2>
          <p className="text-sm text-destructive/90">{scan.error}</p>
        </section>
      ) : null}

      <section className="space-y-2 rounded-lg border bg-card p-4">
        <h2 className="text-lg font-medium">Score</h2>
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(scan.score ?? {}, null, 2)}
        </pre>
      </section>

      <section className="space-y-2 rounded-lg border bg-card p-4">
        <h2 className="text-lg font-medium">Evidence</h2>
        {evidenceItems.length > 0 ? (
          <div className="space-y-2">
            {evidenceItems.map((item) => (
              <div key={item.id} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {item.id} - {item.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  Tool: {item.tool} | Status: {item.status} | Fetched: {item.fetchedAt}
                </p>
                {item.error ? <p className="text-xs text-destructive">Error: {item.error}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(scan.evidence ?? {}, null, 2)}
        </pre>
      </section>
    </main>
  );
}
