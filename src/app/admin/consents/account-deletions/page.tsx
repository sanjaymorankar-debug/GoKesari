import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { ACCOUNT_DELETION_STATUSES, type AccountDeletionStatus } from "@/server/db/schema";
import { listDeletionRequests } from "@/server/services/account-deletion";

export const metadata = { title: "Account deletion requests" };
export const dynamic = "force-dynamic";

const TONES: Record<AccountDeletionStatus, "success" | "warning" | "danger" | "info"> = {
  REQUESTED: "info",
  BLOCKED: "warning",
  COMPLETED: "success",
  CANCELLED: "danger",
};

function when(value: Date | null): string {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—";
}

/**
 * docs/account-deletion-2026-11: every self-service deletion request, read-only.
 * The accounts themselves are anonymised, so only the account id, the outcome,
 * what blocked it and the person's optional reason are shown. Same permission
 * as the consent record (CONSENT_VIEW).
 */
export default async function AccountDeletionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSENT_VIEW)) redirect("/");
  const params = await searchParams;
  const status = ACCOUNT_DELETION_STATUSES.find((s) => s === params.status);
  const rows = await listDeletionRequests({ status, limit: 200 });

  return (
    <>
      <PageHeader
        title="Account deletion requests"
        description="Customers who asked to delete their own account. A completed request means the account was anonymised; orders, invoices, payments and ledgers are kept for legal retention."
        action={
          <LinkButton href="/admin/consents" variant="secondary">
            Consent record
          </LinkButton>
        }
      />
      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2 text-sm">
        {[undefined, ...ACCOUNT_DELETION_STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={s ? `/admin/consents/account-deletions?status=${s}` : "/admin/consents/account-deletions"}
            aria-current={s === status ? "page" : undefined}
            className={`rounded-lg border px-3 py-1 ${s === status ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
          >
            {s ? s.toLowerCase() : "all"}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title="No account deletion requests yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="account-deletion-requests">
            <thead>
              <tr className="border-b bg-gray-100 text-left">
                <th className="px-4 py-3 font-semibold">Requested</th>
                <th className="px-4 py-3 font-semibold">Account id</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Completed</th>
                <th className="px-4 py-3 font-semibold">Blocked by / reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b align-top hover:bg-gray-50">
                  <td className="px-4 py-3 text-ink-600">{when(r.requestedAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-700">{r.userId}</td>
                  <td className="px-4 py-3">
                    <Badge tone={TONES[r.status]}>{r.status.toLowerCase()}</Badge>
                  </td>
                  <td className="px-4 py-3 text-ink-600">{when(r.completedAt)}</td>
                  <td className="px-4 py-3 text-ink-700">
                    {r.blockers.length > 0 ? r.blockers.map((b) => b.code.toLowerCase().replace(/_/g, " ")).join(", ") : null}
                    {r.reason ? <p className="text-ink-500">“{r.reason}”</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
