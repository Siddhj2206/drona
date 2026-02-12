"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HudHeader } from "@/components/scan/hud-header";

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
        setError("No contract bytecode found on Base. Use a Base token contract address.");
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
        error?: string;
      };

      if (!response.ok || !data.scanId) {
        throw new Error(data.error ?? "Failed to create scan");
      }

      router.push(`/scan/${data.scanId}`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "Unable to create scan right now. Please try again.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="h-screen w-screen relative">
      <HudHeader />

      <div className="flex h-full items-center justify-center px-6 pt-16 pb-6">
        <div className="relative flex w-full max-w-4xl flex-col items-center justify-center animate-fade-in">
          <div className="absolute h-[600px] w-[600px] rounded-full border border-[#00f3ff]/20 dashed-circle animate-spin-slow opacity-40" />
          <div className="absolute h-[400px] w-[400px] rotate-45 border border-[#00f3ff]/30 opacity-40" />
          <div className="absolute h-px w-[500px] bg-[#00f3ff]/20 opacity-40" />
          <div className="absolute h-[500px] w-px bg-[#00f3ff]/20 opacity-40" />

          <h1 className="mb-4 text-center text-5xl font-bold tracking-tight text-white text-glow md:text-7xl">
            INPUT_TARGET
          </h1>
          <p className="mb-10 font-mono text-xs uppercase tracking-[0.22em] text-[#00f3ff]/70">
            Base token contract only
          </p>

          <form className="group relative w-full max-w-3xl" onSubmit={handleSubmit}>
            <div className="absolute -inset-0.5 rounded bg-[#00f3ff] opacity-20 blur-sm transition-opacity duration-500 group-hover:opacity-40" />

            <div className="clip-corner-tr relative flex items-center border border-[#00f3ff] bg-[#030014]/90 p-1">
              <div className="p-4 text-[#00f3ff]/50 animate-pulse">
                <Search className="h-5 w-5" />
              </div>
              <Input
                placeholder="0x..."
                value={tokenAddress}
                onChange={(event) => setTokenAddress(event.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                spellCheck={false}
                className="h-14 flex-1 rounded-none border-0 bg-transparent px-4 py-4 font-mono text-xl uppercase tracking-wider text-white shadow-none placeholder:text-gray-600 focus-visible:ring-0"
              />
              <Button
                type="submit"
                disabled={isSubmitting}
                className="h-14 rounded-none border-l border-[#00f3ff]/50 bg-[#00f3ff]/20 px-8 font-mono text-sm uppercase tracking-widest text-[#00f3ff] hover:bg-[#00f3ff] hover:text-black"
              >
                {isSubmitting ? "SCANNING" : "SCAN"}
              </Button>
            </div>

            {error ? <p className="mt-3 text-sm text-[#ff0055]">{error}</p> : null}
          </form>

        </div>
      </div>
    </main>
  );
}
