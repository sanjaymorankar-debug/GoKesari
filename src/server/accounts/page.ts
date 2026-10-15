/**
 * Shared start of every Inventory & Accounting page (docs/inventory-accounting-2026-10):
 * the signed-in owner's shop, or — for an administrator helping a shop —
 * the shop named in ?shop=. Anyone else is sent away, exactly as the API
 * refuses them.
 */
import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

import type { Lang } from "@/lib/board/i18n";
import { getCurrentUser, type AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { shops, type Shop } from "@/server/db/schema";
import { ownerShop } from "./access";

export interface AccountsPage {
  user: AuthenticatedUser;
  shop: Shop;
  lang: Lang;
  /** "?shop=…" to keep on links when an administrator is looking. */
  shopQuery: string;
}

export async function loadAccountsPage(searchParams?: Record<string, string | string[] | undefined>): Promise<AccountsPage> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/accounts");
  const wanted = typeof searchParams?.shop === "string" && /^[0-9a-f-]{36}$/i.test(searchParams.shop) ? searchParams.shop : null;
  let shop: Shop | null = null;
  let shopQuery = "";
  if (wanted) {
    const [row] = await db.select().from(shops).where(and(eq(shops.id, wanted), isNull(shops.deletedAt)));
    if (row && (row.ownerId === user.id || can(user.role, PERMISSIONS.SYSTEM_CONFIG))) {
      shop = row;
      if (row.ownerId !== user.id) shopQuery = `?shop=${row.id}`;
    }
  }
  shop ??= await ownerShop(user.id);
  if (!shop) redirect("/shop");
  return { user, shop, lang: await getBoardLang(), shopQuery };
}

/** Today's month and the date range helpers pages use. */
export function monthRange(period: string): { from: string; to: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${period}-01`, to: next };
}

export function currentPeriod(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
}
