/** "Save my cart as a list": into one of the customer's lists, or a new one (docs/purchase-lists-2026-10). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { LIST_LIMITS } from "@/lib/purchase-lists";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { saveCartToList } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ listId: z.string().uuid() }),
  z.object({
    name: z.string().min(1).max(LIST_LIMITS.nameLength * 2),
    kind: z.enum(["SHOPPING", "MEDICINE"]).optional(),
    frequency: z.enum(["WEEKLY", "MONTHLY"]).optional(),
    remind: z.boolean().optional(),
  }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  return ok(await saveCartToList(user.id, body), 201);
});
