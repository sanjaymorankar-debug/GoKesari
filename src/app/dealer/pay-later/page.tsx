import Link from "next/link";
import { redirect } from "next/navigation";

import { FeePayLaterTable, type PayLaterTableRow } from "@/components/admin/fee-pay-later-table";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getDealerForUser } from "@/server/dealers/service";
import { SHOP_FEE_PAY_LATER_STATUSES, type ShopFeePayLaterStatus } from "@/server/db/schema";
import { dualVerifyRedirect } from "@/server/dual-auth/policy";
import { listPayLaterRequests } from "@/server/services/fee-pay-later";

export const metadata = { title: "Pay-later requests" };
export const dynamic = "force-dynamic";

const LABEL: Record<ShopFeePayLaterStatus | "ALL", string> = {
  REQUESTED: "Waiting for you",
  APPROVED: "Approved (being recovered)",
  SETTLED: "Paid in full",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  ALL: "All",
};

const ist = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(":", ".") : null;

/**
 * docs/fee-pay-later-2026-11 (0229; owner, 28-Nov-2026): shop owners who registered with this dealer's / franchise's
 * code and asked to pay the registration fee later. The dealer approves (the fee no longer holds the shop; it is
 * taken from the shop's payouts) or rejects with a reason.
 */
export default async function DealerPayLaterPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/dealer/pay-later");
  const verifyAt = await dualVerifyRedirect(user.id, "/dealer/pay-later").catch(() => null);
  if (verifyAt) redirect(verifyAt);
  const dealer = await getDealerForUser(user.id);
  if (!dealer || dealer.status === "DRAFT" || dealer.status === "REJECTED") redirect("/dealer");
  const p = await searchParams;
  const status = ([...SHOP_FEE_PAY_LATER_STATUSES, "ALL"] as string[]).includes(p.status ?? "") ? (p.status as ShopFeePayLaterStatus | "ALL") : "REQUESTED";
  const { rows, counts } = await listPayLaterRequests(status, { approverUserId: user.id });
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
    shopId: null, // the admin shop page is not the dealer's
    shopName: r.shopName,
    shopStatus: r.shopStatus,
    registrationNumber: r.registrationNumber,
    referralCode: r.referralCode,
    approver: null,
    canDecide: r.decider === "DEALER",
  }));
  const tabs: (ShopFeePayLaterStatus | "ALL")[] = ["REQUESTED", "APPROVED", "SETTLED", "REJECTED", "CANCELLED", "ALL"];
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <PageHeader
        title="Pay-later requests"
        description="Shops registered with your code that asked to pay the registration fee later. Approve: the fee no longer holds the shop back (it goes live once GoKesari's checks pass) and the fee is taken from the shop's payouts until it is paid. Reject: the owner pays the fee as usual. Times in IST."
        action={<LinkButton href="/dealer" variant="secondary">Dealer page</LinkButton>}
      />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {tabs.map((t) => (
          <Link key={t} href={`/dealer/pay-later?status=${t}`} className={`rounded-full border px-3 py-1 ${t === status ? "border-ink-900 bg-ink-900 text-white" : "border-ink-300 text-ink-700"}`}>
            {LABEL[t]}
            {t !== "ALL" ? ` (${counts[t]})` : ""}
          </Link>
        ))}
      </nav>
      {tableRows.length === 0 ? (
        <EmptyState title="No requests here" description="Nothing to show for this filter." />
      ) : (
        <FeePayLaterTable rows={tableRows} apiPath="/api/dealer/fee-pay-later" showApprover={false} />
      )}
    </div>
  );
}
