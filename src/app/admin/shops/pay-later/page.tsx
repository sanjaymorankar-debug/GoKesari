import Link from "next/link";
import { redirect } from "next/navigation";

import { FeePayLaterTable, type PayLaterTableRow } from "@/components/admin/fee-pay-later-table";
import { EmptyState, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { SHOP_FEE_PAY_LATER_STATUSES, type ShopFeePayLaterStatus } from "@/server/db/schema";
import { listPayLaterRequests, payLaterEnabled } from "@/server/services/fee-pay-later";

export const metadata = { title: "Pay-later requests" };
export const dynamic = "force-dynamic";

const LABEL: Record<ShopFeePayLaterStatus | "ALL", string> = {
  REQUESTED: "Waiting",
  APPROVED: "Approved (being recovered)",
  SETTLED: "Paid in full",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  ALL: "All",
};

const ist = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(":", ".") : null;

/**
 * docs/fee-pay-later-2026-11 (0229): owners who asked to pay the registration fee later. Approve → the shop goes live
 * (now, or when the owner finishes registering) and the fee is taken from its payouts; Reject → the owner pays as before.
 * Administrators only.
 */
export default async function FeePayLaterPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REGISTRATION_FEE_MANAGE)) redirect("/");
  const p = await searchParams;
  const status = ([...SHOP_FEE_PAY_LATER_STATUSES, "ALL"] as string[]).includes(p.status ?? "") ? (p.status as ShopFeePayLaterStatus | "ALL") : "REQUESTED";
  const [{ rows, counts }, enabled] = await Promise.all([listPayLaterRequests(status), payLaterEnabled()]);
  const tableRows: PayLaterTableRow[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    amount: formatPaise(r.amountPaise),
    recovered: formatPaise(r.recoveredPaise),
    due: r.duePaise === null ? null : formatPaise(r.duePaise),
    ownerNote: r.ownerNote,
    decisionNote: r.decisionNote,
    requestedAt: ist(r.requestedAt)!,
    decidedAt: ist(r.decidedAt),
    owner: r.ownerName ?? r.ownerEmail ?? "—",
    ownerContact: [r.ownerPhone, r.ownerEmail].filter(Boolean).join(" · "),
    shopId: r.shopId,
    shopName: r.shopName,
    shopStatus: r.shopStatus,
    registrationNumber: r.registrationNumber,
    referralCode: r.referralCode,
    approver: r.approverName ? `${r.approverName}${r.referralCode ? ` (${r.referralCode})` : ""}` : null,
    // Owner, 28-Nov-2026: the dealer / franchise whose code the shop used decides; admins decide the rest.
    canDecide: r.decider === "ADMIN",
  }));
  const tabs: (ShopFeePayLaterStatus | "ALL")[] = ["REQUESTED", "APPROVED", "SETTLED", "REJECTED", "CANCELLED", "ALL"];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Pay-later requests"
        description="Shop owners who asked to pay the registration fee later. The dealer / franchise whose referral code the shop used approves or rejects in their dealer portal; you decide only requests without such a dealer (or whose dealer is no longer active). Approved: the shop goes live and the fee is taken from its payouts (all of a payout when it is smaller than the fee) until paid; the owner is reminded every week. Times in IST."
      />
      {!enabled ? <p className="text-sm text-ink-600">The Pay later choice is switched off (feature flag shop_fee_pay_later_enabled): owners cannot ask now. Approved requests are still recovered from payouts.</p> : null}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {tabs.map((t) => (
          <Link
            key={t}
            href={`/admin/shops/pay-later?status=${t}`}
            className={`rounded-full border px-3 py-1 ${t === status ? "border-ink-900 bg-ink-900 text-white" : "border-ink-300 text-ink-700"}`}
          >
            {LABEL[t]}
            {t !== "ALL" ? ` (${counts[t]})` : ""}
          </Link>
        ))}
      </nav>
      {tableRows.length === 0 ? <EmptyState title="No requests here" description="Nothing to show for this filter." /> : <FeePayLaterTable rows={tableRows} />}
    </div>
  );
}
