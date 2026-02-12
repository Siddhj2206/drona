export default function ScanReportLoading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-10">
      <p className="text-sm text-muted-foreground">Loading scan report...</p>
      <div className="h-24 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-36 animate-pulse rounded-lg border bg-muted/40" />
      <div className="h-48 animate-pulse rounded-lg border bg-muted/40" />
    </main>
  );
}
