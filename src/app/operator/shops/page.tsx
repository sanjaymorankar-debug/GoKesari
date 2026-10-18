import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listMyOnboardedShops } from "@/server/services/operator-limited";

export const metadata = { title: "My shops" };
export const dynamic = "force-dynamic";

/** F8.4.2 — the shops this Operator (Limited) onboarded; nobody else's. */
export default async function OperatorShopsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.OPERATOR_LIMITED_ONBOARD)) redirect("/");
  const status = (await searchParams).status;
  const all = await listMyOnboardedShops(user);
  const shops = typeof status === "string" ? all.filter((s) => s.status === status) : all;

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-3 py-4">
      <PageHeader title="My shops" description="Shops you onboarded for their owners." />
      <div className="flex flex-wrap gap-2 text-sm">
        <Link className="min-h-10 rounded-full border border-cream-200 bg-white px-3 py-2" href="/operator/shops">All ({all.length})</Link>
        <Link className="min-h-10 rounded-full border border-cream-200 bg-white px-3 py-2" href="/operator/shops?status=PENDING_APPROVAL">
          Pending ({all.filter((s) => s.status === "PENDING_APPROVAL").length})
        </Link>
      </div>
      {shops.length === 0 ? (
        <EmptyState title="No shops yet" description="Shops you onboard appear here." />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {shops.map((s) => (
            <li key={s.shopId} className="rounded-xl border border-cream-200 bg-white p-3">
              <Link href={`/operator/shops/${s.shopId}`} className="block min-h-11">
                <p className="font-semibold text-ink-900">{s.name}</p>
                <p className="text-xs text-ink-500">{s.registrationNumber ?? "—"} · owner {s.session?.ownerEmail ?? "—"}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={s.status === "APPROVED" ? "success" : s.status === "REJECTED" ? "danger" : "warning"}>{s.status.replace(/_/g, " ")}</Badge>
                  <Badge tone={s.feePaymentStatus === "PAID" ? "success" : "neutral"}>
                    Fee {s.feePaymentStatus.toLowerCase()} · {formatPaise(s.amountPaidPaise)} / {formatPaise(s.registrationFeePaise ?? 0)}
                  </Badge>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
