import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;
