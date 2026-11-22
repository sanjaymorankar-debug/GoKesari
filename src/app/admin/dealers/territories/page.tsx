import { notFound, redirect } from "next/navigation";

import { getCurrentUser } from "@/server/authz/guards";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Franchise" };
export const dynamic = "force-dynamic";

/**
 * Owner, 21-Nov-2026: a territory and a franchise are the same thing; territories are sold as franchise zones.
 * The old page opens Admin → Franchise — for a signed-in admin or operator only (a guest still goes to sign-in).
 */
export default async function TerritoryDealersPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  redirect("/admin/franchise");
}
