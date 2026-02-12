CREATE TABLE "scan_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"type" text NOT NULL,
	"step_key" text,
	"message" text NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_events_scan_seq_uidx" ON "scan_events" USING btree ("scan_id","seq");--> statement-breakpoint
CREATE INDEX "scan_events_scan_id_idx" ON "scan_events" USING btree ("scan_id","id");--> statement-breakpoint
CREATE INDEX "scan_events_scan_ts_idx" ON "scan_events" USING btree ("scan_id","ts");