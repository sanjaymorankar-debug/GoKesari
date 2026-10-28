/** GET — the signed-in dealer's commission statement as CSV (own entries only). docs/dealer-programme. */
import { NextResponse } from "next/server";

import { notFound } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listLedger, statementCsv } from "@/server/dealers/commission";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  const csv = statementCsv(await listLedger({ dealerId: dealer.id }));
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="gokesari-commission-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "private, no-store",
    },
  });
});
