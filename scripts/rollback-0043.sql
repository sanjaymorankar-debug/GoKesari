-- Reverses drizzle/0043_rider_change_requests.sql (drops pending rider change requests).
-- Afterwards delete the 0043 row from drizzle.__drizzle_migrations.
DROP TABLE IF EXISTS "delivery_partner_change_requests";
