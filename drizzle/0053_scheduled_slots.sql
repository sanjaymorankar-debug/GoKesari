-- 0053 GS-027: the customer chooses a date and time slot for a scheduled
-- delivery. The chosen slot is stored on the order (scheduled_slot_start /
-- _end; delivery_slot_key "YYYY-MM-DD@HH:MM"), and a shop or area can cap
-- orders per slot (delivery_slot_capacities.scheduled_per_slot) on top of the
-- existing per-day cap. All new columns are nullable: existing orders and
-- limits keep their meaning. Behaviour is switched by the scheduledSlots rule
-- (off by default). Rollback: scripts/rollback-0053.sql
ALTER TABLE "delivery_slot_capacities" ADD COLUMN "scheduled_per_slot" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "scheduled_slot_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "scheduled_slot_end" timestamp with time zone;
