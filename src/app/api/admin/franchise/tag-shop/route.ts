/** Admin: POST { shopId, code, reason } — tag a shop to a dealer code although it is outside the code's area (override, logged). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { adminTagShop } from "@/server/franchise/codes";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ shopId: z.string().uuid(), code: z.string().min(4).max(20), reason: z.string().min(5).max(300) }));
  await adminTagShop(b.shopId, b.code, b.reason, actor);
  return ok({ tagged: true }, 201);
});
