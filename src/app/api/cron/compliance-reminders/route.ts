/**
 * Billing v2 (docs/billing §5.7, §6.1): daily. Tells admins about GoKesari's
 * own returns due within three days (or overdue) and not filed, issues any
 * s.9(5) delivery-fee invoice that could not be issued at delivery, posts
 * GoKesari's activity into every shop's books, and (from the 2nd) tells shop
 * owners that last month's statements are ready.
 *   curl -X POST https://<host>/api/cron/compliance-reminders -H "Authorization: Bearer $CRON_SECRET"
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { istDay } from "@/server/statutory/rates";
import { sendComplianceReminders } from "@/server/tax/compliance";
import { issueMissingDeliveryFeeInvoices } from "@/server/tax/money-flow";
import { postGokesariActivityForAllShops } from "@/server/accounts/platform-posting";
import { sendMonthlyShopStatements } from "@/server/tax/statements";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  if (!(await isFeatureEnabled("billing_v2"))) return ok({ skipped: "billing_v2 is off" });
  const reminders = await sendComplianceReminders(istDay(new Date()));
  const deliveryInvoices = await issueMissingDeliveryFeeInvoices();
  // Shops' books get GoKesari's orders, fees, taxes and payouts; owners hear when last month's statements are ready.
  const books = await postGokesariActivityForAllShops();
  const statements = await sendMonthlyShopStatements(istDay(new Date()));
  return ok({ reminders, deliveryInvoices, books, statements });
});
