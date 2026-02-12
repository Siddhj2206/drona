"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const tokenAddressRegex = /^0x[a-fA-F0-9]{40}$/;

export default function ScanPage() {
  const router = useRouter();
  const [tokenAddress, setTokenAddress] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedAddress = tokenAddress.trim();

    if (!tokenAddressRegex.test(trimmedAddress)) {
      setError("Enter a valid token contract address.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const preflightResponse = await fetch(
        `/api/preflight/contract-code?address=${encodeURIComponent(trimmedAddress)}`,
      );
      const preflightData = (await preflightResponse.json()) as {
        hasCode?: boolean;
        error?: string;
      };

      if (!preflightResponse.ok) {
        throw new Error(preflightData.error ?? "Unable to verify address");
      }

      if (!preflightData.hasCode) {
        setError(
          "This address has no contract code on Base. Use a Base token contract address, not a wallet address.",
        );
        setIsSubmitting(false);
        return;
      }

      const response = await fetch("/api/scans", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tokenAddress: trimmedAddress }),
      });

      const data = (await response.json()) as {
        scanId?: string;
        status?: "queued" | "complete" | "failed";
        error?: string;
      };

      if (!response.ok || !data.scanId) {
        throw new Error(data.error ?? "Failed to create scan");
      }

      router.push(`/scan/${data.scanId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create scan right now. Please try again.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-3xl items-center px-6 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Start a token scan</CardTitle>
          <CardDescription>
            Enter a Base token contract address to generate a shareable risk report.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              placeholder="0x..."
              value={tokenAddress}
              onChange={(event) => setTokenAddress(event.target.value)}
              disabled={isSubmitting}
              autoComplete="off"
              spellCheck={false}
            />

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating scan..." : "Scan token"}
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => setTokenAddress("0xf43eb8de897fbc7f2502483b2bef7bb9ea179229")}
            >
              Use sample Base token
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
