import { redirect } from "next/navigation";

import { NewspaperSubscribe } from "@/components/newspaper-subscribe";
import { PageHeader } from "@/components/ui";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { listAddresses } from "@/server/services/addresses";
import { listPeriodicalTitles } from "@/server/services/newspaper-subscriptions";
import { getWalletByUserId } from "@/server/services/wallet";

export const metadata = { title: "Newspapers & magazines" };
export const dynamic = "force-dynamic";

/**
 * Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11):
 * tick the titles, choose the address, pick a nearby vendor, submit once.
 */
export default async function NewspapersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/subscriptions/newspapers");

  const [titles, addresses, wallet] = await Promise.all([
    listPeriodicalTitles(),
    listAddresses(user.id),
    getWalletByUserId(user.id),
  ]);
  const today = todayIn(getEnv().APP_TIMEZONE);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Newspapers & magazines"
        description="Choose the papers and magazines you want, pick a vendor near you, and get them delivered every day, week or month."
      />
      <NewspaperSubscribe
        titles={titles}
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          area: a.area,
          city: a.city,
          pincode: a.pincode,
          isDefault: a.isDefault,
        }))}
        walletBalancePaise={wallet?.balancePaise ?? 0}
        defaultStartDate={addDays(today, 1)}
        minDate={today}
      />
    </div>
  );
}
