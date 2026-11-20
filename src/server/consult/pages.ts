/**
 * Consultant appointments: which firm a seller-side page is about
 * (docs/consult-booking-2026-11). ?shopId= for staff, the onboarding
 * operator or an owner of several shops; else the active owned shop, else
 * the firm the user is a team member of.
 */
import { and, eq } from "drizzle-orm";

import { activeShop } from "@/server/active-shop";
import { db } from "@/server/db";
import { consultMembers, shops } from "@/server/db/schema";
import { listShopsForOwner } from "@/server/services/shops";
import { firmAccessOrNull, type ConsultActor, type FirmAccess } from "./access";

export async function firmForPage(actor: ConsultActor, requested?: string | null): Promise<{ shopId: string; shopName: string; shopSlug: string; access: FirmAccess } | null> {
  const candidates: string[] = [];
  if (requested && /^[0-9a-f-]{36}$/i.test(requested)) candidates.push(requested);
  const owned = await listShopsForOwner(actor.id).catch(() => []);
  if (owned.length) candidates.push((await activeShop(owned)).id);
  const memberOf = await db.select({ shopId: consultMembers.shopId }).from(consultMembers).where(and(eq(consultMembers.userId, actor.id), eq(consultMembers.status, "ACTIVE"))).limit(1);
  if (memberOf[0]) candidates.push(memberOf[0].shopId);
  for (const shopId of candidates) {
    const access = await firmAccessOrNull(shopId, actor);
    if (!access) continue;
    const [shop] = await db.select({ name: shops.name, slug: shops.slug }).from(shops).where(eq(shops.id, shopId));
    if (shop) return { shopId, shopName: shop.name, shopSlug: shop.slug, access };
  }
  return null;
}
