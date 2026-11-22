import Link from "next/link";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";

import { ApprovalsQueue, type ApprovalRow } from "@/components/approvals-queue";
import { JournalComposer, JournalList, PeriodList, RateProposals } from "@/components/staff/accounting-desk";
import { PageHeader } from "@/components/ui";
import { istToday } from "@/lib/fulfilment-options";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listApprovals } from "@/server/approvals";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { listJournals, listPeriods, trialBalance } from "@/server/rbac-accounting/journals";
import { listRateProposals } from "@/server/rbac-accounting/rates";
import { isFeatureEnabledForRole } from "@/server/services/feature-flags";

export const metadata = { title: "Accounting" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "journals", label: "Journals" },
  { key: "approvals", label: "To approve" },
  { key: "periods", label: "Periods" },
  { key: "rates", label: "Rates" },
  { key: "tb", label: "Trial balance" },
] as const;

const ist = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * RBAC v2 Phase 3 accounting desk (docs/rbac/03-phase3-accounting.md): Accountant (maker) and CA (checker).
 * Behind rbac_v2_accounting for the viewer's role.
 */
export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const canPrepare = can(user.role, PERMISSIONS.JOURNAL_PREPARE);
  const canApprove = can(user.role, PERMISSIONS.JOURNAL_APPROVE);
  if (!canPrepare && !canApprove) redirect("/staff");
  if (!(await isFeatureEnabledForRole("rbac_v2_accounting", user.role))) redirect("/staff");
  const tab = (await searchParams).tab ?? (canApprove && !canPrepare ? "approvals" : "journals");
  const today = istToday();

  let body: React.ReactNode = null;
  if (tab === "journals") {
    const rows = (await listJournals({ limit: 100 })).map((j) => ({
      id: j.id,
      entryNumber: j.entryNumber,
      entryDate: j.entryDate,
      periodCode: j.periodCode,
      narration: j.narration,
      status: j.status,
      totalPaise: j.totalPaise,
      mine: j.preparedBy === user.id,
      rejectionComment: j.rejectionComment,
    }));
    body = (
      <div className="grid gap-3">
        {canPrepare ? <JournalComposer today={today} /> : null}
        <JournalList rows={rows} canPrepare={canPrepare} today={today} />
      </div>
    );
  } else if (tab === "approvals") {
    const pending = (await listApprovals({ statuses: ["PENDING"], checkers: ["CA", "CA_THEN_ADMIN"] })).filter((r) => r.checker === "CA" || r.stage === 1);
    const ids = [...new Set(pending.map((r) => r.requestedBy))];
    const people = ids.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name || p.email]));
    const rows: ApprovalRow[] = pending.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      reason: r.reason,
      status: r.status,
      checker: r.checker,
      stage: r.stage,
      requestedBy: r.requestedBy,
      requestedByName: nameOf.get(r.requestedBy) ?? "Unknown",
      requestedAtIst: ist(r.requestedAt),
      confirmByIst: null,
      overdue: false,
      mine: r.requestedBy === user.id,
    }));
    body = canApprove ? <ApprovalsQueue rows={rows} canSingleAdmin={false} /> : <p className="text-sm text-ink-600">Entries you submitted wait here for the CA.</p>;
  } else if (tab === "periods") {
    const rows = (await listPeriods()).map((p) => ({ code: p.code, status: p.status, closedAtIst: p.closedAt ? ist(p.closedAt) : null, note: p.note }));
    body = <PeriodList rows={rows} canClose={can(user.role, PERMISSIONS.FIN_PERIOD_CLOSE)} />;
  } else if (tab === "rates") {
    const rows = (await listRateProposals()).map((p) => ({
      id: p.id,
      title:
        p.rateKind === "COMMISSION"
          ? `Commission ${p.scope ?? ""} → ${(Number(p.proposedValue.rateBp) / 100).toFixed(2)}%`
          : `${p.rateKind === "REGISTRATION_FEE" ? "Registration fee" : "Delivery charge"} → ${rupees(Number(p.proposedValue.amountPaise))}`,
      status: p.status,
      effectiveIst: ist(p.effectiveAt),
      mine: p.proposedBy === user.id,
    }));
    body = <RateProposals rows={rows} canPropose={can(user.role, PERMISSIONS.RATE_PROPOSE)} />;
  } else {
    const tb = await trialBalance();
    body = (
      <div className="overflow-x-auto">
        <a className="text-sm font-semibold text-kesari-800 hover:underline" href="/api/staff/accounting/trial-balance?format=csv">
          Download CSV
        </a>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-ink-600">
              <th className="py-1">Account</th>
              <th className="py-1 text-right">Debit</th>
              <th className="py-1 text-right">Credit</th>
              <th className="py-1 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.accountCode} className="border-t border-cream-200">
                <td className="py-1">
                  {r.accountCode} {r.accountName}
                </td>
                <td className="py-1 text-right">{rupees(r.debitPaise)}</td>
                <td className="py-1 text-right">{rupees(r.creditPaise)}</td>
                <td className="py-1 text-right">{rupees(r.balancePaise)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-ink-300 font-semibold">
              <td className="py-1">Total</td>
              <td className="py-1 text-right">{rupees(tb.totalDebitPaise)}</td>
              <td className="py-1 text-right">{rupees(tb.totalCreditPaise)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/staff" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My work
      </Link>
      <PageHeader title="Accounting" description="Accountant prepares, CA approves. Posted entries are never edited: reverse them instead." />
      <nav className="mb-3 flex flex-wrap gap-1" aria-label="Accounting sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/staff/accounting?tab=${t.key}`}
            className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ${tab === t.key ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
