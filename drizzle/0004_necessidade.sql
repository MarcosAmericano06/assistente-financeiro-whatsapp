ALTER TABLE "categories" ADD COLUMN "default_necessity" text;--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "set_necessity" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "necessity" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "necessity_source" text;