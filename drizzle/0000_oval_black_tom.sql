CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'base' NOT NULL,
	"token_address" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"scanner_version" text NOT NULL,
	"score_version" text NOT NULL,
	"evidence" jsonb,
	"score" jsonb,
	"narrative" text,
	"model" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "scans_chain_token_idx" ON "scans" USING btree ("chain","token_address");--> statement-breakpoint
CREATE INDEX "scans_created_at_idx" ON "scans" USING btree ("created_at");