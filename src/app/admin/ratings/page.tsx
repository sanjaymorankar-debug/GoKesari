import { redirect } from "next/navigation";

import { ModerateRatingButton } from "@/components/rating-actions";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listRatingsForModeration } from "@/server/services/ratings";

export const metadata = { title: "Ratings" };
export const dynamic = "force-dynamic";

/** Operations: recent shop and rider ratings with hide/restore (GS-059 moderation). */
export default async function AdminRatingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.RATING_MODERATE)) redirect("/");
  const rows = await listRatingsForModeration(150);

  return (
    <>
      <PageHeader title="Ratings" description="Hidden ratings drop out of shop and rider averages. Customer identities are never shown." />
      {rows.length === 0 ? (
        <EmptyState title="No ratings yet." />
      ) : (
        <Card className="divide-y divide-cream-100">
          {rows.map(({ rating: r, orderNumber, shopName, riderName }) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-ink-900">
                  {r.score}★ · {r.targetType === "SHOP" ? `shop ${shopName}` : `rider ${riderName}`} · {orderNumber}
                </p>
                {r.comment ? <p className="text-xs text-ink-600">&ldquo;{r.comment}&rdquo;</p> : null}
                {r.moderationReason ? <p className="text-xs text-ink-400">Hidden: {r.moderationReason}</p> : null}
              </div>
              <span className="flex items-center gap-2">
                <StatusBadge status={r.status} />
                <ModerateRatingButton ratingId={r.id} hidden={r.status === "HIDDEN"} />
              </span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
