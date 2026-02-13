# Drona

Drona is an evidence-first token risk scanner for Base. It runs deterministic data collection (RPC, DEX, honeypot, holders, BaseScan), then produces a structured report with scam-oriented checks and AI-assisted narrative.

## What it does

- Validates contract existence on Base before scanning.
- Collects evidence for:
  - swap safety (honeypot sellability + buy/sell taxes)
  - liquidity posture (V2 LP burn/deployer-share signal)
  - holder concentration (top holders and distribution)
  - contract control (owner status + risky admin capabilities)
- Persists scan timeline events and streams them live to the UI.
- Caches recent completed scans to reduce repeated external API calls.

## Stack

- Next.js App Router (React 19, TypeScript)
- PostgreSQL + Drizzle ORM
- Recharts for report visualizations
- AI SDK + Cerebras for planning/assessment/chat grounding

## Environment variables

Required:

- `DATABASE_URL` - Postgres connection string
- `BASE_RPC_URL` - Base JSON-RPC endpoint

Recommended (scanner quality/features):

- `CEREBRAS_API_KEY`
- `CEREBRAS_MODEL` (default: `llama-3.3-70b`)
- `ETHERSCAN_API_KEY` or `BASESCAN_API_KEY` (enables verified source/creation/ABI checks)
- `BITQUERY_ACCESS_TOKEN` (holder distribution)

Optional tuning:

- `SCAN_CACHE_TTL_SECONDS` (default: `900`)
- `DEX_API_BASE_URL` (default: DexScreener public API)
- `HONEYPOT_API_KEY`
- `BITQUERY_ENDPOINT`
- `BITQUERY_HOLDERS_MODE` (`fast` | `full` | `off`, default: `fast`)
- `BITQUERY_MAX_ARCHIVE_ATTEMPTS`
- `BITQUERY_MIN_HOLDER_ROWS`
- `DATABASE_URL_DIRECT` (for drizzle tooling)

## Local development

1. Install dependencies:

```bash
npm install
```

2. Run DB migrations:

```bash
npm run db:migrate
```

3. Start dev server:

```bash
npm run dev
```

4. Open `http://localhost:3000`.

## Scanner flow

1. `POST /api/scans` validates input + contract code, and may return a cached complete scan.
2. `POST /api/scans/[scanId]/run` enqueues scan work.
3. Background job runner claims pending jobs and executes the full evidence + assessment pipeline.
4. `GET /api/scans/[scanId]/stream` streams timeline events (SSE) to the live UI.
5. `GET /api/scans/[scanId]` returns final report payload.

## Notes

- Some checks are heuristic by design (for example LP lock inference from burn/deployer share).
- When data is unavailable, the UI should show unknown/unavailable rather than fabricated values.
- Holder fallback mode (`balance_updates`) is treated as USD-weighted ranking, not supply percentages.
