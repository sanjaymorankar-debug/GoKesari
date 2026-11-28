import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerPromoteAdmin } from "@/components/dealer/dealer-promote-admin";
import { PromotionConfirmations } from "@/components/dealer/promotion-confirmations";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listPendingPromotions, PROMOTION_CONFIRMER_ROLES } from "@/server/dealers/promotion";
import { listPendingSuperRequests } from "@/server/dealers/super-requests";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Promote to dealer / super dealer" };
export const dynamic = "force-dynamic";

/**
 * Admin → Dealers → Promote (owner, 28-Nov-2026): search any shop or dealer; promote a live shop's owner to dealer
 * (four-eye: a different admin / operator confirms) or an approved dealer to super dealer; approve or reject the
 * super dealer requests dealers raised themselves. Admin and operator.
 */
export default async function DealerPromotePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const [promotions, superRequests] = await Promise.all([listPendingPromotions(), listPendingSuperRequests()]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Promote to dealer / super dealer"
        description="Find a shop or a dealer by name, owner, mobile, shop ID or dealer code. A live shop's owner becomes a dealer from the shop's verified details once a second admin or operator confirms. An approved dealer becomes a super dealer: at once by an admin, or by request when an operator asks."
      />
      <PromotionConfirmations items={JSON.parse(JSON.stringify(promotions))} viewerId={user.id} canDecide={PROMOTION_CONFIRMER_ROLES.includes(user.role)} />
      <DealerPromoteAdmin viewerId={user.id} isAdmin={user.role === "ADMIN"} superRequests={superRequests} />
    </div>
  );
}
