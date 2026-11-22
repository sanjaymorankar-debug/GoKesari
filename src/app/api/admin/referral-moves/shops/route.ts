/** Admin: GET ?q= — shops by name, phone or id for a referral move, with the team and code they are with now. */
import { type NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { searchShopsForMove } from "@/server/dealers/referral-moves";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireRole("ADMIN");
  return ok({ shops: await searchShopsForMove(request.nextUrl.searchParams.get("q") ?? "") });
});
