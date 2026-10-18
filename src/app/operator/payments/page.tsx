import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listMyOnboardedShops } from "@/server/services/operator-limited";

export const metadata = { title: "Payment links" };
export const dynamic = "force-dynamic";

const TONE = { PAID: "success", WAIVED: "success", PENDING: "warning", FAILED: "danger", EXPIRED: "danger", NONE: "neutral" } as const;

/** F8.4.2 — status of the registration-fee links / checkouts of this operator's shops. */
export default async function OperatorPaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.OPERATOR_LIMITED_ONBOARD)) redirect("/");
  const status = (await searchParams).status;
  const rows = (await listMyOnboardedShops(user)).filter((s) => s.session && s.session.feeStatus !== "NONE");
  const shown = status === "FAILED" ? rows.filter((r) => r.session?.feeStatus === "FAILED" || r.session?.feeStatus === "EXPIRED") : rows;
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Payment links" description="Registration fees of the shops you onboarded. A failed or expired fee leaves the shop with an administrator." />
      {shown.length === 0 ? (
        <EmptyState title="No payment links" />
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <li key={r.shopId} className="rounded-xl border border-cream-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/operator/shops/${r.shopId}`} className="font-semibold text-ink-900 underline">{r.name}</Link>
                <Badge tone={TONE[r.session!.feeStatus]}>{r.session!.feeStatus}</Badge>
              </div>
              <p className="text-xs text-ink-500">
                {r.session!.feeMode === "CHECKOUT" ? "Paid in session" : "Link to owner"} · {formatPaise(r.registrationFeePaise ?? 0)}
                {r.session!.feeExpiresAt ? ` · until ${r.session!.feeExpiresAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}` : ""}
                {r.session!.feeFailureReason ? ` · ${r.session!.feeFailureReason}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
