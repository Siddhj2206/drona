import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ScanNotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-2xl flex-col items-start justify-center gap-4 px-6 py-10">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Scan not found</h1>
      <p className="text-sm text-muted-foreground">
        This report does not exist, has an invalid id, or is no longer available.
      </p>
      <Button asChild>
        <Link href="/scan">Start a new scan</Link>
      </Button>
    </main>
  );
}
