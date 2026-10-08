/**
 * Which shop a Module 2 page is about: `?shop=` (support, or an owner with
 * more than one shop) after the access check, else the owner's shop.
 */
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { getCurrentUser, type AuthenticatedUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { listShopsForOwner } from "@/server/services/shops";
import { assertIntegrationAccess, type IntegrationAccessMode, type IntegrationActor } from "./connections";

export async function integrationPageShop(
  shopParam: string | string[] | undefined,
  mode: IntegrationAccessMode = "view",
): Promise<{ user: AuthenticatedUser; actor: IntegrationActor; shop: { id: string; name: string } }> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const wanted = typeof shopParam === "string" && /^[0-9a-f-]{36}$/i.test(shopParam) ? shopParam : null;
  let shop: { id: string; name: string } | undefined;
  if (wanted) {
    [shop] = await db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.id, wanted));
  } else {
    const [own] = await listShopsForOwner(user.id);
    shop = own ? { id: own.id, name: own.name } : undefined;
  }
  if (!shop) redirect("/shop");
  const actor = await assertIntegrationAccess(shop.id, user, mode);
  return { user, actor, shop };
}
