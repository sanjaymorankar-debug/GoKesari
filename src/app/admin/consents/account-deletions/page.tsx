import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Alert, Badge, Button, EmptyState, LinkButton, PageHeader, inputClass } from "@/components/ui";
import { toClientError } from "@/lib/errors";
import { getCurrentUser, requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { ACCOUNT_DELETION_STATUSES, type AccountDeletionStatus } from "@/server/db/schema";
import { adminCancelDeletion, formatPurgeDate, listDeletionRequests } from "@/server/services/account-deletion";

export const metadata = { title: "Account deletion requests" };
export const dynamic = "force-dynamic";

const TONES: Record<AccountDeletionStatus, "success" | "warning" | "danger" | "info"> = {
  REQUESTED: "info",
  BLOCKED: "warning",
  COOLING_OFF: "warning",
  COMPLETED: "success",
  CANCELLED: "danger",
};

function when(value: Date | null): string {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—";
}

/**
 * docs/account-deletion-2026-11: every self-service deletion request. Same
 * permission as the consent record (CONSENT_VIEW). A completed request's account
 * is anonymised, so only its id is shown. An account in its cooling-off period
 * (0199) is marked "Under cooling period until <date>" with the person's reason;
 * its name and email are shown to admins only (USER_SUSPEND), and an admin may
 * cancel the deletion (restores the account) with a note — audited.
 */
export default async function AccountDeletionsPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string; done?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSENT_VIEW)) redirect("/");
  const isAdmin = can(user.role, PERMISSIONS.USER_SUSPEND);
  const params = await searchParams;
  const status = ACCOUNT_DELETION_STATUSES.find((s) => s === params.status);
  const rows = await listDeletionRequests({ status, limit: 200, includePersonal: isAdmin });

  async function cancelDeletion(form: FormData) {
    "use server";
    const actor = await requirePermission(PERMISSIONS.USER_SUSPEND);
    try {
      await adminCancelDeletion({ id: actor.id, role: actor.role }, String(form.get("requestId") ?? ""), String(form.get("note") ?? ""));
    } catch (error) {
      redirect(`/admin/consents/account-deletions?error=${encodeURIComponent(toClientError(error).body.error.message)}`);
    }
    revalidatePath("/admin/consents/account-deletions");
    redirect("/admin/consents/account-deletions?done=1");
  }

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
      {params.error ? <Alert tone="danger">{params.error}</Alert> : null}
      {params.done ? <Alert tone="success">The deletion was cancelled and the account restored.</Alert> : null}
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
                <th className="px-4 py-3 font-semibold">Account</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Completed</th>
                <th className="px-4 py-3 font-semibold">Blocked by / reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b align-top hover:bg-gray-50">
                  <td className="px-4 py-3 text-ink-600">{when(r.requestedAt)}</td>
                  <td className="px-4 py-3 text-ink-700">
                    {r.person ? (
                      <p data-testid="account-deletion-person">
                        {r.person.name ?? "—"} <span className="text-ink-500">{r.person.email}</span>
                      </p>
                    ) : null}
                    <p className="font-mono text-xs">{r.userId}</p>
                  </td>
                  <td className="px-4 py-3">
                    {r.status === "COOLING_OFF" && r.purgeAfter ? (
                      <span data-testid="account-deletion-cooling">
                        <Badge tone="warning">Under cooling period until {formatPurgeDate(r.purgeAfter)}</Badge>
                      </span>
                    ) : (
                      <Badge tone={TONES[r.status]}>{r.status.toLowerCase().replace(/_/g, " ")}</Badge>
                    )}
                    {r.status === "BLOCKED" && r.purgeAfter ? (
                      <p className="mt-1 text-xs text-amber-800">Held at purge time — the account stays hidden; retried daily.</p>
                    ) : null}
                    {r.cancelNote ? <p className="mt-1 text-xs text-ink-500">Cancelled: {r.cancelNote}</p> : null}
                  </td>
                  <td className="px-4 py-3 text-ink-600">{when(r.completedAt)}</td>
                  <td className="px-4 py-3 text-ink-700">
                    {r.blockers.length > 0 ? r.blockers.map((b) => b.code.toLowerCase().replace(/_/g, " ")).join(", ") : null}
                    {r.reason ? <p className="text-ink-500">“{r.reason}”</p> : null}
                    {isAdmin && (r.status === "COOLING_OFF" || (r.status === "BLOCKED" && r.purgeAfter)) ? (
                      <form action={cancelDeletion} className="mt-2 grid gap-2">
                        <input type="hidden" name="requestId" value={r.id} />
                        <input className={inputClass} name="note" required minLength={3} maxLength={500} placeholder="Why is the deletion cancelled?" />
                        <Button type="submit" size="sm" variant="secondary">
                          Cancel deletion (restore account)
                        </Button>
                      </form>
                    ) : null}
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
