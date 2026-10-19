/**
 * Database handles for the seller / customer split (docs/db-split-2026-10).
 *
 * On the split ("overlay") layout the site still opens one connection, to the
 * core (customer) database, and reaches every seller table there through
 * postgres_fdw foreign tables of the same names — so both handles are the
 * site's one database (`db`) in every mode. They mark which side a query
 * belongs to; a hot seller-only path can later talk to the seller database
 * directly once the switch has happened (the product master already does:
 * src/server/pmd/db.ts). Code that reads across the two goes through
 * cross-reads.ts and checks relationships with integrity.ts.
 */
import { getEnv } from "@/lib/env";
import { db, type Database } from "@/server/db";

export type SplitMode = "single" | "shadow" | "split";

export function splitMode(): SplitMode {
  return getEnv().DB_SPLIT_MODE;
}

/** Shops, KYC, catalogue, inventory, pricing, shop wallet, payouts. */
export function sellerDb(): Database {
  return db;
}

/** Customers, addresses, carts, orders, customer wallet, reviews — and the platform tables. */
export function customerDb(): Database {
  return db;
}
