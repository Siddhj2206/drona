import { claimNextPendingScanJob, finalizeScanJob } from "@/lib/db/scan-jobs";
import { runQueuedScan } from "@/lib/scanner/scan-runner";

declare global {
  var __dronaScanWorkerPromise: Promise<void> | null | undefined;
}

async function processJobsLoop() {
  while (true) {
    const job = await claimNextPendingScanJob();
    if (!job) {
      return;
    }

    try {
      const result = await runQueuedScan(job.scanId);

      if (result.status === "failed") {
        await finalizeScanJob(job.id, "failed", result.error);
      } else if (result.status === "skipped") {
        await finalizeScanJob(job.id, "skipped", result.reason);
      } else {
        await finalizeScanJob(job.id, "completed", null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Background scan worker failed";
      await finalizeScanJob(job.id, "failed", message);
    }
  }
}

export function triggerScanJobWorker() {
  if (globalThis.__dronaScanWorkerPromise) {
    return globalThis.__dronaScanWorkerPromise;
  }

  globalThis.__dronaScanWorkerPromise = processJobsLoop().finally(() => {
    globalThis.__dronaScanWorkerPromise = null;
  });

  return globalThis.__dronaScanWorkerPromise;
}
