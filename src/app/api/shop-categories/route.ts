/**
 * Shop categories.
 *   GET ?q=&all=1  the list for pickers (active only; staff may pass all=1 to include inactive, with shop counts)
 *   POST { name, description? }  create (operator / admin)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser, requireRole } from "@/server/authz/guards";
import { createShopCategory, listShopCategories } from "@/server/services/shop-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const p = new URL(request.url).searchParams;
  const user = await getCurrentUser();
  const staff = user?.role === "OPERATOR" || user?.role === "ADMIN";
  const categories = await listShopCategories({
    activeOnly: !(staff && p.get("all") === "1"),
    query: p.get("q") ?? undefined,
  });
  return ok({
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      ...(staff ? { shopCount: c.shopCount } : {}),
    })),
  });
});

const schema = z.object({ name: z.string().min(2).max(80), description: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("OPERATOR", "ADMIN");
  return ok(await createShopCategory(await parseBody(request, schema), user), 201);
});
