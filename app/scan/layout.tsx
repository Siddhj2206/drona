import type { ReactNode } from "react";
import "./scan-theme.css";

export default function ScanLayout({ children }: { children: ReactNode }) {
  return (
    <div className="scan-theme relative h-screen w-screen overflow-hidden text-[#00f3ff] selection:bg-[#00f3ff] selection:text-black">
      <div className="stars" aria-hidden />
      <div className="hex-grid" aria-hidden />

      <div className="fixed top-0 left-0 z-50 h-8 w-8 border-l-2 border-t-2 border-[#00f3ff]/50" aria-hidden />
      <div className="fixed top-0 right-0 z-50 h-8 w-8 border-r-2 border-t-2 border-[#00f3ff]/50" aria-hidden />
      <div className="fixed bottom-0 left-0 z-50 h-8 w-8 border-l-2 border-b-2 border-[#00f3ff]/50" aria-hidden />
      <div className="fixed right-0 bottom-0 z-50 h-8 w-8 border-r-2 border-b-2 border-[#00f3ff]/50" aria-hidden />

      <div className="scan-content">{children}</div>
    </div>
  );
}
