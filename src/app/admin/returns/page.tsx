import { redirect } from "next/navigation";

import { ReturnCase } from "@/components/return-case";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { RETURN_STATUSES, RETURN_STATUS_LABELS, type ReturnStatus } from "@/lib/return-states";
import { getCurrentUser } from "@/server/authz/guards";
import { getReturnDetail, listAllReturns } from "@/server/services/returns";

export const metadata = { title: "Returns" };
export const dynamic = "force-dynamic";

/** Operations view of every return, with the same actions as the shop plus manual overrides. */
export default async function AdminReturnsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const { status } = await searchParams;
  const filter = RETURN_STATUSES.find((s) => s === status) as ReturnStatus | undefined;

  const list = await listAllReturns({ status: filter, limit: 60 });
  const details = await Promise.all(list.map((r) => getReturnDetail(r.id, user)));

  return (
    <>
      <PageHeader title="Returns" description="Every customer return across the marketplace." />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter by status">
        <LinkButton href="/admin/returns" variant={filter ? "secondary" : "primary"}>
          All
        </LinkButton>
        {RETURN_STATUSES.map((s) => (
          <LinkButton key={s} href={`/admin/returns?status=${s}`} variant={filter === s ? "primary" : "secondary"}>
            {RETURN_STATUS_LABELS[s]}
          </LinkButton>
        ))}
      </nav>
      {details.length === 0 ? (
        <EmptyState title="No returns match." />
      ) : (
        <div className="space-y-4">
          {details.map((detail) => (
            <ReturnCase key={detail.ret.id} detail={detail} />
          ))}
        </div>
      )}
    </>
  );
}
