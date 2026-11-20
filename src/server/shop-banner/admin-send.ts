/**
 * docs/shop-welcome-kit-2026-11, owner requirement 7: shops that were already
 * live when the welcome kit was built are NOT e-mailed automatically. An ADMIN
 * sends it from Admin → Shops → Send welcome kit — to one shop, or to every
 * live shop of a city or district that has not had it (preview first).
 *
 * Same outbox and same rule as the automatic e-mail (queueShopWelcomeKit):
 * once per shop, ever; a failed send is retried by the outbox. A bulk run does
 * not send at once: the rows wait for the outbox sweep (50 per run), so a big
 * city cannot flood the mail server. Off until an admin turns on the feature
 * flag shop_welcome_kit_admin_send_enabled (Admin → Feature flags); the owner
 * is told before any bulk run on gokesari.com.
 */
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { db } from "@/server/db";
import { shops, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled, requireFeature } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";

import { localBannerLanguage, type BannerLanguage } from "./render";
import { WELCOME_KIT_DOC_TYPE, queueShopWelcomeKit, welcomeKitStatuses, type WelcomeKitStatus } from "./welcome-kit";

export const WELCOME_KIT_ADMIN_FLAG = "shop_welcome_kit_admin_send_enabled" as const;
/** Most shops one bulk run queues (run it again for the rest). */
export const WELCOME_KIT_BULK_LIMIT = 200;
/** Most shops a search or preview lists. */
const LIST_LIMIT = 100;
/** Most candidates read to filter by district (district comes from the PIN code, not a column). */
const SCAN_LIMIT = 5000;

type Actor = { id: string; role: UserRole };

export interface WelcomeKitShop {
  id: string;
  name: string;
  registrationNumber: string | null;
  city: string;
  state: string | null;
  pincode: string;
  slug: string;
  ownerId: string;
  /** False: the owner has no real e-mail address, so the outbox would mark it SKIPPED. */
  ownerHasEmail: boolean;
  local: Exclude<BannerLanguage, "en">;
  welcomeKit: WelcomeKitStatus | null;
}

export interface WelcomeKitFilter {
  /** Shop name or registration number. */
  q?: string | null;
  city?: string | null;
  /** geo_areas code of a DISTRICT (matched through the shop's PIN code). */
  districtCode?: string | null;
  /** Only shops that never had the welcome kit. */
  notWelcomedOnly?: boolean;
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Live shops matching the filter, with their welcome-kit status. `total` counts every match, `shops` holds at most `limit`. */
export async function findWelcomeKitShops(filter: WelcomeKitFilter, limit = LIST_LIMIT): Promise<{ total: number; shops: WelcomeKitShop[] }> {
  const q = clean(filter.q);
  const city = clean(filter.city);
  const districtCode = clean(filter.districtCode);
  const conditions = [eq(shops.status, "APPROVED"), isNull(shops.deletedAt)];
  if (q) conditions.push(or(ilike(shops.name, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), eq(shops.registrationNumber, q.toUpperCase()))!);
  if (city) conditions.push(sql`lower(trim(${shops.city})) = lower(${city})`);
  if (filter.notWelcomedOnly) {
    conditions.push(
      sql`not exists (select 1 from document_emails d where d.doc_type = ${WELCOME_KIT_DOC_TYPE} and d.doc_id = ${shops.id})`,
    );
  }
  const rows = await db
    .select({
      id: shops.id,
      name: shops.name,
      registrationNumber: shops.registrationNumber,
      city: shops.city,
      state: shops.state,
      pincode: shops.pincode,
      slug: shops.slug,
      ownerId: shops.ownerId,
      ownerEmail: users.email,
    })
    .from(shops)
    .innerJoin(users, eq(users.id, shops.ownerId))
    .where(and(...conditions))
    .orderBy(asc(shops.city), asc(shops.name))
    .limit(districtCode ? SCAN_LIMIT : 10_000);

  let matched = rows;
  if (districtCode) {
    const byPin = new Map<string, Promise<string | null>>();
    const districtOf = (pin: string) => {
      if (!byPin.has(pin)) byPin.set(pin, districtCodeForPincode(pin));
      return byPin.get(pin)!;
    };
    const codes = await Promise.all(rows.map((r) => districtOf(r.pincode)));
    matched = rows.filter((_, i) => codes[i] === districtCode);
  }
  const page = matched.slice(0, limit);
  const statuses = await welcomeKitStatuses(page.map((r) => r.id));
  return {
    total: matched.length,
    shops: page.map(({ ownerEmail, ...r }) => ({
      ...r,
      ownerHasEmail: Boolean(ownerEmail && !isPlaceholderEmail(ownerEmail)),
      local: localBannerLanguage(r),
      welcomeKit: statuses.get(r.id) ?? null,
    })),
  };
}

export async function welcomeKitAdminSendEnabled(): Promise<boolean> {
  return isFeatureEnabled(WELCOME_KIT_ADMIN_FLAG);
}

export type WelcomeKitSendResult = "QUEUED" | "ALREADY_SENT" | "NOT_QUEUED";

/** Sends the welcome kit to one live shop (once per shop, ever). NOT_QUEUED: the owner opted out of shop e-mails. */
export async function sendWelcomeKitToShop(shopId: string, actor: Actor): Promise<{ shopId: string; result: WelcomeKitSendResult; welcomeKit: WelcomeKitStatus | null }> {
  await requireFeature(WELCOME_KIT_ADMIN_FLAG);
  const [shop] = await db
    .select({ id: shops.id, ownerId: shops.ownerId, name: shops.name, slug: shops.slug, state: shops.state, pincode: shops.pincode, status: shops.status, deletedAt: shops.deletedAt })
    .from(shops)
    .where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.status !== "APPROVED") throw conflict("Only a live (approved) shop gets the welcome kit: its QR code opens the shop's page, which is shown for live shops only.");
  const queued = await queueShopWelcomeKit(shop);
  const welcomeKit = (await welcomeKitStatuses([shop.id])).get(shop.id) ?? null;
  if (queued) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_WELCOME_KIT_SENT,
      entityType: "shop",
      entityId: shop.id,
      newValue: { docType: WELCOME_KIT_DOC_TYPE, via: "ADMIN" },
    });
  }
  return { shopId: shop.id, result: queued ? "QUEUED" : welcomeKit ? "ALREADY_SENT" : "NOT_QUEUED", welcomeKit };
}

/**
 * Queues the welcome kit for every live shop of a city or district that never had it — at most
 * WELCOME_KIT_BULK_LIMIT per run. The e-mails go out with the outbox sweep, not at once.
 */
export async function sendWelcomeKitBulk(
  filter: { city?: string | null; districtCode?: string | null },
  actor: Actor,
): Promise<{ matched: number; queued: number; notQueued: number; remaining: number }> {
  await requireFeature(WELCOME_KIT_ADMIN_FLAG);
  if (!clean(filter.city) && !clean(filter.districtCode)) throw validationFailed("Choose a city or a district for a bulk run.");
  const { total, shops: targets } = await findWelcomeKitShops({ ...filter, notWelcomedOnly: true }, WELCOME_KIT_BULK_LIMIT);
  let queued = 0;
  for (const shop of targets) {
    if (await queueShopWelcomeKit(shop, db, { deliverNow: false })) queued += 1;
  }
  const result = { matched: total, queued, notQueued: targets.length - queued, remaining: Math.max(0, total - targets.length) };
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_WELCOME_KIT_BULK_SENT,
    entityType: "shop_welcome_kit",
    newValue: { city: clean(filter.city) || null, districtCode: clean(filter.districtCode) || null, ...result },
  });
  return result;
}
