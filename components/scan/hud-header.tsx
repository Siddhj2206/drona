"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type HudHeaderProps = {
  showHudToggle?: boolean;
  hudVisible?: boolean;
  onToggleHud?: () => void;
  showTimelineButton?: boolean;
  onOpenTimeline?: () => void;
};

export function HudHeader({
  showHudToggle = false,
  hudVisible = true,
  onToggleHud,
  showTimelineButton = false,
  onOpenTimeline,
}: HudHeaderProps) {
  const [gasPrice, setGasPrice] = useState(0.14);
  const [activeNodes, setActiveNodes] = useState(24);

  useEffect(() => {
    const interval = setInterval(() => {
      setGasPrice((current) => Math.max(0.08, current + (Math.random() - 0.5) * 0.02));
      setActiveNodes(() => 21 + Math.floor(Math.random() * 9));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const gasText = useMemo(() => gasPrice.toFixed(3), [gasPrice]);

  return (
    <header className="pointer-events-none absolute top-0 left-0 right-0 z-50 h-16 bg-gradient-to-b from-[#030014]/90 to-transparent">
      <div className="flex h-full items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-[#00f3ff] text-xs font-bold text-black animate-pulse-slow">
            AI
          </div>
          <div>
            <p className="text-xl font-bold tracking-[0.2em] text-white">DRONA</p>
            <p className="text-[10px] uppercase tracking-[0.4em] text-[#00f3ff]/60">Sentinel_Protocol_v1</p>
          </div>
        </div>

        <div className="hidden items-center gap-8 font-mono text-[10px] tracking-widest text-[#00f3ff]/50 md:flex">
          <div className="flex items-center gap-2">
            <span>SYS_STATUS:</span>
            <span className="text-[#00ff94]">ONLINE</span>
            <span className="h-2 w-2 rounded-full bg-[#00ff94] animate-ping-slow" />
          </div>
          <div className="flex items-center gap-2">
            <span>GAS_PRICE:</span>
            <span>{gasText}</span>
          </div>
          <div className="flex items-center gap-2">
            <span>NODES_ACTIVE:</span>
            <span>{activeNodes}</span>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-3">
          {showHudToggle ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onToggleHud}
              className="border-[#00f3ff]/30 bg-[#030014]/60 px-4 py-2 font-mono text-xs tracking-widest uppercase hover:bg-[#00f3ff]/20"
            >
              {hudVisible ? "Hide_HUD" : "Show_HUD"}
            </Button>
          ) : null}

          {showTimelineButton ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onOpenTimeline}
              className="border-[#00f3ff]/30 bg-[#030014]/60 px-4 py-2 font-mono text-xs tracking-widest uppercase hover:bg-[#00f3ff]/20"
            >
              Timeline
            </Button>
          ) : null}

          <Button
            asChild
            size="sm"
            variant="outline"
            className="border-[#00f3ff]/30 bg-[#030014]/60 px-4 py-2 font-mono text-xs tracking-widest uppercase hover:bg-[#00f3ff]/20"
          >
            <Link href="/scan">Reset_Module</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
