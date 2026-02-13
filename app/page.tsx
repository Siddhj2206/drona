import Link from "next/link";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#050411] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(0,243,255,0.18),transparent_35%),radial-gradient(circle_at_80%_30%,rgba(0,255,148,0.12),transparent_40%),linear-gradient(to_bottom,rgba(8,8,20,0.9),rgba(5,4,17,1))]" />

      <section className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-20">
        <p className="mb-4 font-mono text-xs tracking-[0.28em] text-[#00f3ff]/75">DRONA / BASE TOKEN RISK SCANNER</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-6xl">
          Fast forensic scans for Base tokens.
        </h1>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-white/75 sm:text-base">
          Drona evaluates swap behavior, LP lock posture, holder concentration, and contract control signals. Reports stay evidence-first and
          call out unknowns when data is unavailable.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href="/scan"
            className="rounded-md border border-[#00f3ff]/50 bg-[#00f3ff]/10 px-6 py-3 font-mono text-xs tracking-[0.16em] text-[#00f3ff] transition hover:bg-[#00f3ff]/20"
          >
            START_SCAN
          </Link>
          <Link
            href="/scan"
            className="rounded-md border border-white/20 px-6 py-3 font-mono text-xs tracking-[0.16em] text-white/80 transition hover:border-white/40 hover:text-white"
          >
            OPEN_CONSOLE
          </Link>
        </div>

        <div className="mt-14 grid gap-3 text-xs font-mono text-white/70 sm:grid-cols-3">
          <div className="rounded-md border border-white/15 bg-white/5 p-4">
            <p className="text-[#00ff94]">SWAP SAFETY</p>
            <p className="mt-2 leading-relaxed">Buy/sell simulation plus tax extraction via honeypot evidence.</p>
          </div>
          <div className="rounded-md border border-white/15 bg-white/5 p-4">
            <p className="text-[#00ff94]">LIQUIDITY POSTURE</p>
            <p className="mt-2 leading-relaxed">V2 LP burn/deployer share signals with confidence labels.</p>
          </div>
          <div className="rounded-md border border-white/15 bg-white/5 p-4">
            <p className="text-[#00ff94]">CONTRACT CONTROL</p>
            <p className="mt-2 leading-relaxed">Ownership and capability checks for mint, blacklist, pause, and fee controls.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
