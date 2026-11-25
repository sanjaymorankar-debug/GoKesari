/**
 * Helpers for the Billing v2 checks (docs/billing; shop accounts, GST
 * documents, POS, TCS / TDS, GST returns, sync) — group E of the cases added
 * on 20-Nov-2026.
 *
 * - feature flags (Admin → Feature flags) switched for one check and always
 *   put back exactly as they were (local only: a flag is site-wide);
 * - the shop's GST registration arranged in the database (GSTIN, status,
 *   type, state) and restored, as an admin's verification would leave it;
 * - the shop accounts API (/api/shops/{id}/accounts/…) and a probe that says
 *   whether billing_v2 is on for a shop (its POS item list answers 404 when off).
 *
 * Nothing here runs on production: every writer asserts the target is writable.
 */
import type { APIRequestContext } from "@playwright/test";

import { as } from "./actors";
import { db } from "./db";
import { call, expectStatus, why, type Answer, type Method } from "./http";
import { blocked } from "./record";
import { gstinFor, uniquePan } from "./sellers-helpers";
import { assertWritable, IS_LOCAL } from "./target";

export const BILLING_FLAGS = ["billing_v2", "tcs_engine", "tds_engine", "delivery_9_5", "gsp_live", "einvoice", "ewaybill", "tally_connector", "dealer_programme_enabled", "dealer_rating_bonus_enabled", "local_price_comparison_enabled"] as const;
export type FlagKey = (typeof BILLING_FLAGS)[number];

interface FlagView {
  key: string;
  enabled: boolean;
  districtCodes: string[] | null;
}

/** Every feature flag as Admin → Feature flags shows it. */
export async function flagStates(): Promise<Map<string, FlagView>> {
  const res = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  expectStatus(res, 200, "GET /api/admin/feature-flags");
  return new Map(((res.body?.flags ?? []) as FlagView[]).map((f) => [f.key, f]));
}

/**
 * Runs `body` with the flags switched (on = on for every district, off = off),
 * through the admin API with a reason, and puts each one back as it was
 * (its districts too). Local only: a flag changes the whole site.
 */
export async function withFlags<T>(changes: Partial<Record<FlagKey, boolean>>, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked("switches feature flags (Admin → Feature flags), local run only");
  assertWritable("switch feature flags");
  const before = await flagStates();
  const admin = await as("admin");
  const changed: FlagView[] = [];
  try {
    for (const [key, on] of Object.entries(changes) as [FlagKey, boolean][]) {
      const was = before.get(key) ?? { key, enabled: false, districtCodes: null };
      if (was.enabled === on && (!on || was.districtCodes === null)) continue;
      const res = await call(admin, "PUT", "/api/admin/feature-flags", { key, enabled: on, districtCodes: null, reason: "QA check (restored after the check)" });
      expectStatus(res, 200, `switch flag ${key} ${on ? "on" : "off"}`);
      changed.push(was);
    }
    return await body();
  } finally {
    for (const was of changed.reverse()) {
      const res = await call(admin, "PUT", "/api/admin/feature-flags", { key: was.key, enabled: was.enabled, districtCodes: was.districtCodes, reason: "QA check: flag restored" });
      expectStatus(res, 200, `restore flag ${was.key}`);
    }
  }
}

/* ------------------------------------------------------------ shop GST */

const GST_COLUMNS = ["gstin", "gst_status", "gst_registration_type", "gst_state_code", "gst_enrolment_id", "gst_portal_status", "einvoice_applicable"] as const;
type GstColumn = (typeof GST_COLUMNS)[number];
export type ShopGst = Partial<Record<GstColumn, string | boolean | null>>;

/**
 * Runs `body` with the shop's GST registration arranged (local only) — what
 * an admin's GST verification or the owner's GST status step leaves on the
 * shop — and puts the columns back afterwards.
 */
export async function withShopGst<T>(shopId: string, gst: ShopGst, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked("arranges the shop's GST registration in the database (local run only)");
  const sql = db();
  const [before] = await sql<Record<GstColumn, string | boolean | null>[]>`
    select gstin, gst_status::text as gst_status, gst_registration_type, gst_state_code, gst_enrolment_id, gst_portal_status, einvoice_applicable
    from shops where id = ${shopId}`;
  if (!before) throw new Error(`no shop ${shopId}`);
  await setShopGst(shopId, gst);
  try {
    return await body();
  } finally {
    await setShopGst(shopId, before);
  }
}

export async function setShopGst(shopId: string, gst: ShopGst) {
  const sql = db();
  const values = Object.fromEntries(Object.entries(gst).filter(([k]) => (GST_COLUMNS as readonly string[]).includes(k)));
  if (!Object.keys(values).length) return;
  await sql`update shops set ${sql(values)}, updated_at = now() where id = ${shopId}`;
}

/** A valid GSTIN of a new PAN in `state` (two-digit code, e.g. "27" Maharashtra, "29" Karnataka). */
export function newGstin(state = "27"): string {
  return gstinFor(uniquePan(), state);
}

/** A regular GST shop in Maharashtra (the tax engine reads it as REGULAR). */
export const REGULAR_MH = (gstin = newGstin("27")): ShopGst => ({ gstin, gst_status: "REGISTERED", gst_registration_type: "UNREGISTERED", gst_state_code: "MH", gst_portal_status: "ACTIVE" });

/* -------------------------------------------------------- accounts API */

export const accountsPath = (shopId: string, rest: string) => `/api/shops/${shopId}/accounts/${rest.replace(/^\//, "")}`;

export async function accounts(ctx: APIRequestContext, method: Method, shopId: string, rest: string, data?: unknown, options: Parameters<typeof call>[4] = {}): Promise<Answer> {
  if (method !== "GET") assertWritable(`${method} ${rest} on the shop's books`);
  return call(ctx, method, accountsPath(shopId, rest), data, options);
}

/**
 * Whether billing_v2 is on for this shop's district: the POS item list
 * answers 200 when it is and 404 "This feature is not available." when not.
 */
export async function billingOn(ctx: APIRequestContext, shopId: string): Promise<boolean> {
  const res = await call(ctx, "GET", accountsPath(shopId, "pos/items"));
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`could not tell whether billing_v2 is on for shop ${shopId}: ${why(res)}`);
}

export interface SalesInvoice {
  id: string;
  invoiceNo: string;
  kind: "TAX_INVOICE" | "BILL_OF_SUPPLY" | null;
  interState: boolean;
  placeOfSupply: string;
  buyerGstin: string | null;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  status: string;
}

/** A counter / B2B sale (POST …/accounts/sales), 201 expected. */
export async function counterSale(ctx: APIRequestContext, shopId: string, body: Record<string, unknown>): Promise<SalesInvoice> {
  const res = await accounts(ctx, "POST", shopId, "sales", body);
  expectStatus(res, 201, "issue the sale");
  return res.body as SalesInvoice;
}

/** The trailing serial of a counter-bill number (S2627-00012 → 12). */
export function serialOf(invoiceNo: string): number {
  return Number(/(\d+)$/.exec(invoiceNo)?.[1] ?? NaN);
}

/** The month (YYYY-MM) in IST, `offset` months from now. */
export function istMonth(offset = 0): string {
  const now = new Date(Date.now() + 330 * 60_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}

export function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/** A line of a counter sale without a listing (no stock movement). */
export function freeLine(description: string, ratePaise: number, gstRateBp: number, qty = 1) {
  return { description, hsn: "1905", qtyMilli: qty * 1000, ratePaise, gstRateBp };
}

/**
 * Before a GST-ready export (local only): fills what the export's fix list
 * asks of the shop's own masters, as the owner would on the screens — an HSN
 * code and GST rate on listings without them, and a UQC for every unit
 * (Settings → Units). Returns what is still to fix (should be nothing).
 */
export async function readyForExport(ctx: APIRequestContext, shopId: string, from: string, to: string): Promise<{ entity: string; key: string; problem: string }[]> {
  if (!IS_LOCAL) blocked("fills the shop's masters for an export (local run only)");
  const fixes = async () => {
    const res = await accounts(ctx, "GET", shopId, `sync/fixes?from=${from}&to=${to}`);
    expectStatus(res, 200, "the export's fix list");
    return res.body as { entity: string; key: string; problem: string }[];
  };
  const first = await fixes();
  if (first.some((f) => f.entity === "STOCK_ITEM")) {
    await db()`update shop_products set hsn_code = coalesce(hsn_code, '1905'), gst_rate_bp = coalesce(gst_rate_bp, 1800) where shop_id = ${shopId}`;
  }
  for (const unit of new Set(first.filter((f) => f.entity === "UNIT").map((f) => f.key))) {
    expectStatus(await accounts(ctx, "PUT", shopId, "sync/units", { unit, uqc: "NOS" }), 200, `UQC for unit ${unit}`);
  }
  return first.length ? fixes() : first;
}
