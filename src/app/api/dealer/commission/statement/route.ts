/**
 * GET — the signed-in dealer's commission statement as CSV (own entries only). docs/dealer-programme.
 * ?month=YYYY-MM → that month's statement: shops registered, commission entries, the month's payout.
 * Without it → every entry, as before.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { notFound, validationFailed } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listLedger, statementCsv } from "@/server/dealers/commission";
import { requireDealerProgramme } from "@/server/dealers/http";
import { dealerMonthStatement, monthStatementCsv } from "@/server/dealers/monthly-payout";
import { getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  const month = request.nextUrl.searchParams.get("month");
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw validationFailed("Give the month as YYYY-MM.");
  const csv = month ? monthStatementCsv(await dealerMonthStatement(dealer.id, month)) : statementCsv(await listLedger({ dealerId: dealer.id }));
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="gokesari-commission-${month ?? new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "private, no-store",
    },
  });
});
