/** "Set up your shop's products": save which step the owner has reached. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { assertCanManageShopCategories } from "@/server/services/product-categories";
import { saveSetupStep } from "@/server/services/shop-product-setup";

export const dynamic = "force-dynamic";

const body = z.object({ step: z.union([z.literal(1), z.literal(2), z.literal(3)]) });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await assertCanManageShopCategories(id, user);
  const { step } = await parseBody(request, body);
  await saveSetupStep(id, step, user);
  return ok({ step });
});
