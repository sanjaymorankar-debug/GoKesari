/**
 * Database handles for the seller / customer split (docs/db-split-2026-10).
 *
 * With DB_SPLIT_MODE=single (the default) or shadow, both handles are the
 * site's one database (`db`), so code written against them behaves exactly
 * as today. With split, the seller handle connects to SELLER_DATABASE_URL.
 * Code that reads across the two goes through cross-reads.ts and checks
 * relationships with integrity.ts — never a SQL join across databases.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/lib/env";
import { db, type Database } from "@/server/db";
import * as schema from "@/server/db/schema";

const globalSplit = globalThis as unknown as { __sellerSql?: ReturnType<typeof postgres>; __customerSql?: ReturnType<typeof postgres> };

export type SplitMode = "single" | "shadow" | "split";

export function splitMode(): SplitMode {
  return getEnv().DB_SPLIT_MODE;
}

function client(url: string, key: "__sellerSql" | "__customerSql"): Database {
  if (!globalSplit[key]) {
    const sslmode = (() => {
      try {
        return new URL(url).searchParams.get("sslmode");
      } catch {
        return null;
      }
    })();
    globalSplit[key] = postgres(url, {
      max: getEnv().DATABASE_POOL_MAX,
      idle_timeout: getEnv().DATABASE_IDLE_TIMEOUT_SECONDS,
      connect_timeout: 30,
      ssl: !sslmode || sslmode === "disable" ? false : "require",
      types: { bigint: postgres.BigInt },
    });
  }
  return drizzle(globalSplit[key]!, { schema });
}

/** Shops, KYC, catalogue, inventory, pricing, shop wallet, payouts. */
export function sellerDb(): Database {
  if (splitMode() !== "split") return db;
  const url = getEnv().SELLER_DATABASE_URL;
  if (!url) throw new Error("DB_SPLIT_MODE=split needs SELLER_DATABASE_URL (the gokesari_seller database).");
  return client(url, "__sellerSql");
}

/** Customers, addresses, carts, orders, customer wallet, reviews — and the platform tables. */
export function customerDb(): Database {
  if (splitMode() !== "split") return db;
  const url = getEnv().CUSTOMER_DATABASE_URL;
  return url && url !== getEnv().DATABASE_URL ? client(url, "__customerSql") : db;
}
