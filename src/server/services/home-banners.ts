/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1). Admins and operators
 * (HOME_BANNER_MANAGE) create, schedule, reorder and switch banners on or off
 * at /admin/home-banners; the home page shows the live ones for the visitor's
 * location (lib/home-banners.ts decides which), else the built-in defaults.
 * Every change is audited.
 */
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { forbidden, notFound } from "@/lib/errors";
import { bannerIsLive, isSafeBannerLink, type BannerSlide, type BannerTarget } from "@/lib/home-banners";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { HOME_BANNER_KINDS, homeBanners, type HomeBanner, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

export type BannerActor = { id: string; role: UserRole };

/** At most this many banners rotate on the home page. */
export const MAX_LIVE_BANNERS = 6;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const bannerInputSchema = z
  .object({
    title: z.string().trim().min(3, "Give it a title.").max(80),
    subtitle: optionalText(160),
    imageUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === "" || /^\/api\/images\/[0-9a-f-]{36}$/i.test(v) || /^\/[\w./-]+\.(png|jpe?g|webp|svg)$/i.test(v) || /^https:\/\/[^\s"'<>]+$/i.test(v), {
        message: "Upload an image, or give a /path or an https:// image link.",
      })
      .transform((v) => v || null)
      .nullish(),
    ctaLabel: optionalText(30),
    ctaHref: z.string().trim().max(500).refine(isSafeBannerLink, { message: "Use a page on this site (starting with /) or an https:// link." }),
    kind: z.enum(HOME_BANNER_KINDS).default("GENERAL"),
    city: optionalText(60),
    pincode: z
      .string()
      .trim()
      .refine((v) => v === "" || /^[1-9][0-9]{5}$/.test(v), { message: "PIN codes have 6 digits." })
      .transform((v) => v || null)
      .nullish(),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt > v.startsAt, { message: "The end must be after the start.", path: ["endsAt"] });
export type BannerInput = z.input<typeof bannerInputSchema>;

function assertCanManage(actor: BannerActor): void {
  if (!can(actor.role, PERMISSIONS.HOME_BANNER_MANAGE)) throw forbidden("You cannot manage home banners.");
}

function toSlide(b: HomeBanner): BannerSlide {
  return { id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl, ctaLabel: b.ctaLabel, ctaHref: b.ctaHref, kind: b.kind };
}

/**
 * The banners the home page rotates for this visitor, in their order. Never
 * throws: on any failure (e.g. the table not migrated yet) it returns [] and
 * the page shows the built-in banners.
 */
export async function listLiveBanners(target: BannerTarget, now = new Date()): Promise<BannerSlide[]> {
  try {
    const rows = await db
      .select()
      .from(homeBanners)
      .where(eq(homeBanners.active, true))
      .orderBy(asc(homeBanners.sortOrder), desc(homeBanners.createdAt))
      .limit(50);
    return rows.filter((b) => bannerIsLive(b, now, target)).slice(0, MAX_LIVE_BANNERS).map(toSlide);
  } catch (error) {
    console.error("[home-banners] live banners could not be read", error);
    return [];
  }
}

/** Every banner, for the admin screen: order first, newest first within an order. */
export async function listAllBanners(actor: BannerActor): Promise<HomeBanner[]> {
  assertCanManage(actor);
  return db.select().from(homeBanners).orderBy(asc(homeBanners.sortOrder), desc(homeBanners.createdAt));
}

export async function createBanner(actor: BannerActor, input: BannerInput): Promise<HomeBanner> {
  assertCanManage(actor);
  const data = bannerInputSchema.parse(input);
  const [last] = await db.select({ sortOrder: homeBanners.sortOrder }).from(homeBanners).orderBy(desc(homeBanners.sortOrder)).limit(1);
  const [row] = await db
    .insert(homeBanners)
    .values({
      ...data,
      sortOrder: data.sortOrder ?? (last ? last.sortOrder + 10 : 0),
      active: data.active ?? true,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOME_BANNER_SAVED, entityType: "home_banner", entityId: row.id, newValue: row });
  return row;
}

export async function updateBanner(actor: BannerActor, id: string, input: BannerInput): Promise<HomeBanner> {
  assertCanManage(actor);
  const data = bannerInputSchema.parse(input);
  const [before] = await db.select().from(homeBanners).where(eq(homeBanners.id, id));
  if (!before) throw notFound("Banner not found.");
  const [row] = await db
    .update(homeBanners)
    .set({ ...data, sortOrder: data.sortOrder ?? before.sortOrder, active: data.active ?? before.active, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(homeBanners.id, id))
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOME_BANNER_SAVED, entityType: "home_banner", entityId: id, previousValue: before, newValue: row });
  return row;
}

/** Switch on/off without touching anything else. */
export async function setBannerActive(actor: BannerActor, id: string, active: boolean): Promise<HomeBanner> {
  assertCanManage(actor);
  const [row] = await db.update(homeBanners).set({ active, updatedBy: actor.id, updatedAt: new Date() }).where(eq(homeBanners.id, id)).returning();
  if (!row) throw notFound("Banner not found.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOME_BANNER_SAVED, entityType: "home_banner", entityId: id, newValue: { active } });
  return row;
}

/**
 * Moves a banner one place up or down: renumbers the whole list in steps of
 * ten in its current order with the two neighbours swapped, so equal or
 * missing orders can never make a move a no-op.
 */
export async function moveBanner(actor: BannerActor, id: string, direction: "up" | "down"): Promise<void> {
  assertCanManage(actor);
  await db.transaction(async (tx) => {
    const rows = await tx.select({ id: homeBanners.id }).from(homeBanners).orderBy(asc(homeBanners.sortOrder), desc(homeBanners.createdAt));
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw notFound("Banner not found.");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (const [n, r] of rows.entries()) {
      await tx.update(homeBanners).set({ sortOrder: n * 10 }).where(eq(homeBanners.id, r.id));
    }
  });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOME_BANNER_SAVED, entityType: "home_banner", entityId: id, newValue: { moved: direction } });
}

export async function deleteBanner(actor: BannerActor, id: string): Promise<void> {
  assertCanManage(actor);
  const [before] = await db.delete(homeBanners).where(eq(homeBanners.id, id)).returning();
  if (!before) throw notFound("Banner not found.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOME_BANNER_DELETED, entityType: "home_banner", entityId: id, previousValue: before });
}
