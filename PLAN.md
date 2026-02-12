# Drona - Agent-Led Scan Architecture Plan

## Goal

Build a Base token risk scanner where the AI agent drives investigation steps, the UI shows every step live, and each claim is backed by tool-fetched evidence with citations.

This project is a risk assessment system, not a binary scam oracle.

## Product Direction

- Base-only for v1.
- Shareable permalink per scan: `/scan/[scanId]`.
- Live "analyzing" experience on the same permalink (status sidebar + terminal + graph).
- Final report on the same permalink after completion.
- AI is responsible for planning and assessment, but can only use approved backend tools.

## Core UX (Most Important Part)

### Pages

- `/scan`
  - Input token address.
  - Creates a scan and redirects to `/scan/[scanId]`.

- `/scan/[scanId]`
  - While running: live analyzer UI.
  - After completion: report UI.
  - Includes Ask Drona chat constrained to stored evidence.

### Live Analyzer Layout (reference-inspired, fresh implementation)

- Left rail: Step sidebar (queued/running/success/warning/failed).
- Main panel: Terminal log stream (append-only, timestamped severity lines).
- Right panel: Graph/status artifacts (updates when corresponding events arrive).

### Report Layout

- Threat score and risk level.
- AI summary and reasons.
- Evidence citations and evidence ledger.
- Missing data / uncertainty section.
- Chat panel.

## Agent Rules and Boundaries

- Agent can only gather facts through backend tools.
- Agent output must be structured JSON and cite evidence IDs.
- Any reason without valid citations is rejected.
- If data is unavailable, agent must mark uncertainty and list missing data.

### Approved tools (v1)

- `rpc_getBytecode`
- `rpc_getErc20Metadata`
- `basescan_getSourceInfo`
- `dexscreener_getPairs`

No open web browsing in v1.

## Orchestration Model

Use a step-based orchestrator with visible transitions.

### Step taxonomy (sidebar keys)

1. `validate_target`
2. `rpc_bytecode`
3. `rpc_metadata`
4. `basescan_verification`
5. `dex_market`
6. `agent_assessment`

### Runtime constraints

- `maxSteps = 6`
- total budget target: `15-20s`
- per-tool timeout (short, deterministic)
- graceful degradation when non-critical tools fail

## Event-Driven Trace Model

The live UI is powered by persisted events (append-only timeline).

### Event types

- `run.started`, `run.completed`, `run.failed`
- `step.started`, `step.completed`, `step.failed`
- `log.line`
- `evidence.item`
- `graph.snapshot` (optional for v1)
- `assessment.final`

### Event fields (minimum)

- `scanId`
- `seq` (monotonic per scan)
- `ts`
- `level` (`info|success|warning|error`)
- `type`
- `stepKey` (nullable)
- `message`
- `payload` (jsonb)

## Data Model (Neon + Drizzle)

### `scans` (existing, source-of-truth header)

- `id`, `chain`, `token_address`, `status`
- `created_at`, `duration_ms`
- `scanner_version`, `score_version`
- `evidence` (final ledger snapshot)
- `score` (final assessment JSON)
- `narrative`, `model`, `error`

### `scan_events` (new, append-only)

- `id` uuid
- `scan_id` uuid fk
- `seq` int (unique per scan)
- `ts` timestamptz
- `level` text
- `type` text
- `step_key` text nullable
- `message` text
- `payload` jsonb

Indexes:

- unique `(scan_id, seq)`
- index `(scan_id, ts)`

Optional later: `scan_steps` aggregate table for faster sidebar queries.

## API Design

### Scan lifecycle

- `POST /api/scans`
  - Validates token address.
  - Creates scan with `status = queued`.
  - Returns `{ scanId }` quickly.

- `GET /api/scans/[scanId]`
  - Returns scan header/report payload.

### Live progress

- `GET /api/scans/[scanId]/stream` (SSE)
  - Replays past events.
  - Tails new events in real time.
  - If scan is queued, endpoint claims and starts execution.
  - Supports resume via cursor (`Last-Event-ID` or `afterSeq`).

- `GET /api/scans/[scanId]/events?after=...` (polling fallback)
  - Returns incremental event slices.

### Chat

- `POST /api/scans/[scanId]/chat`
  - Answers strictly from stored evidence/assessment.

## Streaming Strategy

Primary transport: SSE.

Why:

- Simple server->client stream for terminal-like logs.
- Easy reconnection/resume.
- Fits Vercel serverless better than websocket complexity for v1.

Fallback: incremental polling endpoint.

## AI Output Contract

Final assessment JSON must include:

- `summary`
- `overallScore` (0-100)
- `riskLevel` (`low|medium|high|critical`)
- `confidence` (`low|medium|high`)
- `categoryScores`
- `reasons[]` with required `evidenceRefs[]`
- `missingData[]`

Validation rules:

- At least one reason.
- Every reason cites one or more evidence IDs.
- Every cited evidence ID must exist in the evidence ledger.

## Frontend Implementation Plan

### Phase A - Live run foundation

1. Add `scan_events` schema + migration.
2. Change `POST /api/scans` to create queued scan only.
3. Build `GET /api/scans/[scanId]/stream` SSE with replay + tail.
4. Add runner claim logic (`queued -> running`) and emit run/step/log events.

### Phase B - Analyzer UI

1. Build step sidebar component.
2. Build terminal stream component (autoscroll, severity colors).
3. Wire `/scan/[scanId]` client to SSE stream.
4. Render live step state + log feed + artifacts.

### Phase C - Final report integration

1. Emit `assessment.final` event.
2. Persist assessment to `scans.score` and summary to `scans.narrative`.
3. Transition UI to report mode on completion.

### Phase D - Resilience and polish

1. Add polling fallback endpoint.
2. Add reconnect/resume cursor support.
3. Improve graph updates and citation jump links.
4. Add clear timeout and partial-result behavior.

## Environment Variables

```env
# Database
DATABASE_URL=
DATABASE_URL_DIRECT=

# Chain / providers
BASE_RPC_URL=
BASESCAN_API_KEY=
DEX_API_BASE_URL=

# AI
CEREBRAS_API_KEY=
CEREBRAS_MODEL=

# Scan behavior
SCAN_CACHE_TTL_SECONDS=
```

## Dependencies (no versions)

- Next.js, React, TypeScript
- Tailwind CSS, shadcn/ui
- Drizzle ORM + drizzle-kit
- pg
- zod
- ai (AI SDK core)
- @ai-sdk/cerebras

## Non-Goals for v1

- Multi-chain scans
- Cron-based ecosystem monitoring
- Wallet graph intelligence beyond token scan scope
- External web research by agent

## Success Criteria

- Opening `/scan/[scanId]` shows live, step-by-step progress until completion.
- Every final reason is backed by cited evidence IDs.
- Refreshing the page preserves timeline context (event replay).
- Failed scans show clear step/error cause, not just generic abort text.
