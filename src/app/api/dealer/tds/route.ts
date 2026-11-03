/**
 * The payee's own TDS view (gap report D6): PAN on file, the rate that applies, TDS this
 * financial year, and their Form 16A. GET → the view; GET ?form16a=<id> → that PDF (own PAN only).
 * An approved dealer, or a team member signed in with their own account.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";
import { getMemberForUser } from "@/server/dealers/tiered";
import { form16aFile, payeeTdsView } from "@/server/tax/commission-tds";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  const mine = dealer ? null : await getMemberForUser(user.id);
  if (!dealer && !mine) throw forbidden("Only a dealer or a member of a dealer team has a TDS view.");
  const panHash = dealer ? dealer.panHash : mine!.member.panHash;
  const formId = request.nextUrl.searchParams.get("form16a");
  if (formId) {
    const file = await form16aFile(z.string().uuid().parse(formId), { actor: { id: user.id, role: user.role }, panHash });
    return new NextResponse(new Uint8Array(file.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${file.fileName}"`, "cache-control": "private, no-store" } });
  }
  return ok(await payeeTdsView({ panHash, dealerType: dealer?.dealerType ?? mine!.dealer.dealerType, isMember: !dealer }));
});
