/** A customer's weekly / monthly purchase lists — list and create (docs/purchase-lists-2026-10). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { LIST_LIMITS } from "@/lib/purchase-lists";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { createPurchaseList, listPurchaseLists } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(LIST_LIMITS.nameLength * 2),
  kind: z.enum(["SHOPPING", "MEDICINE"]).optional(),
  frequency: z.enum(["WEEKLY", "MONTHLY"]).optional(),
  remind: z.boolean().optional(),
});

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ lists: await listPurchaseLists(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, createSchema);
  return ok(await createPurchaseList(user.id, body), 201);
});
