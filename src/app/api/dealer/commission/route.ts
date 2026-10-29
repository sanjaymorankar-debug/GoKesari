/**
 * The signed-in dealer's commission (docs/dealer-programme): totals by status, entries, payouts,
 * the rates that apply (read only) and the rating. Own data only.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { applicableRates, commissionSummary, dealerRateView, listLedger, listPayouts, ratingView } from "@/server/dealers/commission";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  const [summary, entries, payouts, rates, rating, rate] = await Promise.all([
    commissionSummary(dealer.id),
    listLedger({ dealerId: dealer.id }),
    listPayouts(dealer.id),
    applicableRates(),
    ratingView(dealer.id),
    dealerRateView(dealer.id),
  ]);
  // rate: the dealer's own commission % (base % model); rates: the milestone rules (earlier model).
  return ok({ summary, entries, payouts, rates, rating, rate });
});
