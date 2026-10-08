import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { ProfileSetupForm } from "@/components/registration/profile-setup-form";
import { PageHeader } from "@/components/ui";
import { SHOP_TYPES } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { profileSetupView } from "@/server/registration/profile";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Complete your profile" };
export const dynamic = "force-dynamic";

/** Module 3: a self-registered shop completes its profile after going live. */
export default async function ProfileSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/profile-setup");
  const params = await searchParams;
  const wanted = typeof params.shop === "string" && /^[0-9a-f-]{36}$/i.test(params.shop) ? params.shop : null;
  const own = await listShopsForOwner(user.id);
  const shop = wanted ? (await db.select().from(shops).where(eq(shops.id, wanted)))[0] : (own.find((s) => !s.profileCompletedAt && s.onboardingChannel === "SELF_SERVICE") ?? own[0]);
  if (!shop) redirect("/shop");
  const view = await profileSetupView(shop.id, user);
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Complete your profile" description={`${view.shop.name} · shop no. ${view.shop.registrationNumber}. Customers find your shop by area once the address is in.`} />
      <ProfileSetupForm
        shop={JSON.parse(JSON.stringify(view.shop))}
        missing={view.missing}
        categories={view.categories}
        fssai={view.fssai}
        shopTypes={SHOP_TYPES.map((t) => ({ key: t.key, label: t.label }))}
      />
    </div>
  );
}
