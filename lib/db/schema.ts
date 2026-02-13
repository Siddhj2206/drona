import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey(),
    chain: text("chain").notNull().default("base"),
    tokenAddress: text("token_address").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms"),
    scannerVersion: text("scanner_version").notNull(),
    scoreVersion: text("score_version").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown> | null>(),
    score: jsonb("score").$type<Record<string, unknown> | null>(),
    narrative: text("narrative"),
    model: text("model"),
    error: text("error"),
  },
  (table) => [
    index("scans_chain_token_idx").on(table.chain, table.tokenAddress),
    index("scans_created_at_idx").on(table.createdAt),
  ],
);

export const scanEvents = pgTable(
  "scan_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    level: text("level").notNull(),
    type: text("type").notNull(),
    stepKey: text("step_key"),
    message: text("message").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    uniqueIndex("scan_events_scan_seq_uidx").on(table.scanId, table.seq),
    index("scan_events_scan_id_idx").on(table.scanId, table.id),
    index("scan_events_scan_ts_idx").on(table.scanId, table.ts),
  ],
);

export const scanJobs = pgTable(
  "scan_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("scan_jobs_status_created_idx").on(table.status, table.createdAt),
    index("scan_jobs_scan_id_idx").on(table.scanId),
  ],
);

export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;
export type ScanEvent = typeof scanEvents.$inferSelect;
export type NewScanEvent = typeof scanEvents.$inferInsert;
export type ScanJob = typeof scanJobs.$inferSelect;
export type NewScanJob = typeof scanJobs.$inferInsert;
