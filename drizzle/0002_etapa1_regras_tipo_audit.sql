CREATE TABLE "owner_settings" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_settings_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "category_rules" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "set_type" "transaction_type";--> statement-breakpoint
ALTER TABLE "owner_settings" ADD CONSTRAINT "owner_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_batch_idx" ON "audit_log" USING btree ("batch_id");--> statement-breakpoint
-- regras duplicadas (mesmo padrão) existiam antes do upsert: mantém só a mais recente
DELETE FROM "category_rules" a USING "category_rules" b
WHERE a."user_id" = b."user_id" AND a."merchant_pattern" = b."merchant_pattern"
  AND (a."created_at", a."id") < (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_rule_pattern_unique" ON "category_rules" USING btree ("user_id","merchant_pattern");