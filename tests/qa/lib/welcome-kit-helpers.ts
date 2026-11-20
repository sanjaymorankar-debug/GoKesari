/**
 * Helpers for the shop welcome kit checks (docs/shop-welcome-kit-2026-11, TC-WKIT-*): the banner
 * download, the QR code read back from a banner, the welcome-kit outbox row and the admin flag.
 */
import type { APIRequestContext } from "@playwright/test";
import jsQR from "jsqr";
import sharp from "sharp";

import { as } from "./actors";
import { db } from "./db";
import { call, expectStatus, RUN } from "./http";
import { blocked } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";

export const WELCOME_KIT_FLAG = "shop_welcome_kit_admin_send_enabled";

/** The QR code in the banner's "Scan QR Code of Your Shop" box (≈ x 1150–1350, y 610–810 of 1536 × 1024). */
export async function bannerQr(png: Buffer): Promise<string | null> {
  const meta = await sharp(png).metadata();
  const sx = (meta.width ?? 1536) / 1536;
  const sy = (meta.height ?? 1024) / 1024;
  const { data, info } = await sharp(png)
    .extract({ left: Math.round(1120 * sx), top: Math.round(590 * sy), width: Math.round(260 * sx), height: Math.round(240 * sy) })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

/** GET /api/shops/<id>/banner as `ctx`, with the file name from Content-Disposition. */
export async function bannerFile(ctx: APIRequestContext, shopId: string, query = ""): Promise<{ status: number; type: string; body: Buffer; filename: string | null }> {
  const res = await ctx.get(new URL(`/api/shops/${shopId}/banner${query}`, BASE_URL).toString(), { failOnStatusCode: false, maxRedirects: 0 });
  const headers = res.headers();
  return {
    status: res.status(),
    type: headers["content-type"] ?? "",
    body: await res.body(),
    filename: /filename="([^"]+)"/.exec(headers["content-disposition"] ?? "")?.[1] ?? null,
  };
}

export interface KitRow {
  id: string;
  user_id: string;
  status: string;
  subject: string;
  to_address: string | null;
  last_error: string | null;
}

/** The shop's welcome-kit outbox rows (local only). */
export async function kitRows(shopId: string): Promise<KitRow[]> {
  return db()<KitRow[]>`
    select id, user_id, status, subject, to_address, last_error from document_emails
    where doc_type = 'SHOP_WELCOME_KIT' and doc_id = ${shopId} order by created_at`;
}

/** Waits until the shop's welcome kit has left PENDING / SENDING (sent just after commit, or by the outbox sweep). */
export async function kitSettled(shopId: string, timeoutMs = 60_000): Promise<KitRow[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await kitRows(shopId);
    if (rows.length > 0 && rows.every((r) => !["PENDING", "SENDING"].includes(r.status))) return rows;
    if (Date.now() >= until) return rows;
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

/** Forgets a shop's welcome kit, as for a shop that was live before the feature (local only). */
export async function forgetKit(shopId: string) {
  if (!IS_LOCAL) blocked("removing outbox rows is for the local database only");
  await db()`delete from document_emails where doc_type = 'SHOP_WELCOME_KIT' and doc_id = ${shopId}`;
}

/** Runs `body` with the admin-send flag switched through Admin → Feature flags (server cache cleared), and puts it back. Local only. */
export async function withWelcomeKitFlag<T>(enabled: boolean, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked("switching feature flags is for the local server only");
  assertWritable("switch a feature flag");
  const admin = await as("admin");
  const list = await call(admin, "GET", "/api/admin/feature-flags");
  expectStatus(list, 200, "GET /api/admin/feature-flags");
  const before = (list.body.flags as { key: string; enabled: boolean; districtCodes: string[] | null }[]).find((f) => f.key === WELCOME_KIT_FLAG) ?? {
    enabled: false,
    districtCodes: null,
  };
  const put = (on: boolean, districtCodes: string[] | null, why: string) =>
    call(admin, "PUT", "/api/admin/feature-flags", { key: WELCOME_KIT_FLAG, enabled: on, districtCodes, reason: `QA local run ${RUN}: ${why}` });
  expectStatus(await put(enabled, null, "welcome kit admin send checks"), 200, `switch ${WELCOME_KIT_FLAG} ${enabled ? "on" : "off"}`);
  try {
    return await body();
  } finally {
    expectStatus(await put(before.enabled, before.districtCodes, "put back after the welcome kit checks"), 200, `restore ${WELCOME_KIT_FLAG}`);
  }
}
