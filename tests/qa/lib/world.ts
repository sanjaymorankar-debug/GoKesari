/**
 * The test data a run works with — accounts, shops, listings — the "Test
 * data" sheet of test-cases.xlsx made concrete for one site.
 *
 * local    written by scripts/qa/seed-local.ts (every account and shop of the
 *          sheet, created in the local database) to test-results/qa/world-<host>.json
 * staging  tests/qa/worlds/staging.json: the existing staging test accounts and
 *          E2E shop; ids are looked up through the site's own APIs when needed
 *
 * A check that needs something this world does not have calls need(), which
 * records the case "blocked" with what was missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HOST, TARGET } from "./target";

export type Role =
  | "customer" // CUSTOMER 1: mobile, default address inside shop A's radius, wallet funded, marketing consent on
  | "customer2" // CUSTOMER 2: email only, no mobile, address outside shop A's radius
  | "shop" // SHOP_OWNER A
  | "shopB" // SHOP_OWNER B: same PIN as A, a shared product at another price, one offline-only product
  | "shopC" // SHOP_OWNER C: approved, no products (category-add cases)
  | "rider" // RIDER 1: approved, online, near shop A
  | "rider2" // RIDER 2: approved, online, farther away
  | "admin"
  | "ops" // OPERATOR
  | "oplim" // OPERATOR_LIMITED
  | "society"; // SOCIETY_ADMIN of a verified society inside shop A's zone

export const ROLE_NAMES: Record<Role, string> = {
  customer: "CUSTOMER",
  customer2: "CUSTOMER",
  shop: "SHOP_OWNER",
  shopB: "SHOP_OWNER",
  shopC: "SHOP_OWNER",
  rider: "DELIVERY_PARTNER",
  rider2: "DELIVERY_PARTNER",
  admin: "ADMIN",
  ops: "OPERATOR",
  oplim: "OPERATOR_LIMITED",
  society: "SOCIETY_ADMIN",
};

export interface WorldUser {
  email: string;
  id?: string;
}

export interface WorldShop {
  id?: string;
  slug?: string;
  name: string;
  pincode?: string;
}

export interface WorldListing {
  shopProductId: string;
  productId: string;
  name: string;
  pricePaise: number | null;
  mrpPaise?: number | null;
  stock?: number;
}

export interface World {
  target: string;
  host: string;
  createdAt?: string;
  users: Partial<Record<Role, WorldUser>>;
  shops: Partial<Record<"A" | "B" | "C" | "pending", WorldShop>>;
  listings: Partial<
    Record<
      // packaged: verified MRP; milk: subscribable at Rs 70/L; loose: priced, by weight;
      // unpricedLoose: loose with no price; offlineOnly: shop B, in-shop only;
      // sharedA / sharedB: the same master product at shop A and shop B (different prices)
      // premium: a pricey packaged line (a basket above the wallet in a few units)
      "packaged" | "milk" | "loose" | "unpricedLoose" | "offlineOnly" | "sharedA" | "sharedB" | "lowStock" | "premium",
      WorldListing
    >
  >;
  society?: { id: string; name: string };
  /** Shop A's PIN and coordinates; customer 1's address is here. */
  location?: { pincode: string; lat: number; lng: number };
  /** A PIN no shop of the world delivers to. */
  outsidePincode?: string;
  /** The default address ids of the customers (local only). */
  addresses?: Partial<Record<Role, string>>;
}

const LOCAL_FILE = join("test-results", "qa", `world-${HOST.replace(/[^a-z0-9.-]/gi, "_")}.json`);

let cached: World | null = null;

export function world(): World {
  if (cached) return cached;
  if (TARGET === "local") {
    if (!existsSync(LOCAL_FILE)) {
      cached = { target: TARGET, host: HOST, users: {}, shops: {}, listings: {} };
    } else {
      cached = JSON.parse(readFileSync(LOCAL_FILE, "utf8")) as World;
    }
  } else {
    const file = join(__dirname, "..", "worlds", `${TARGET}.json`);
    cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as World) : { target: TARGET, host: HOST, users: {}, shops: {}, listings: {} };
  }
  return cached;
}

export const worldFile = LOCAL_FILE;
