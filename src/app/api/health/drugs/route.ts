/** Drug master search for the prescription pad: ?q= (brand or generic). Signed-in users only. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { searchDrugs, searchIcd10 } from "@/server/health/drugs";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireUser();
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (request.nextUrl.searchParams.get("icd") === "1") return ok({ codes: await searchIcd10(q) });
  return ok({ drugs: await searchDrugs(q) });
});
