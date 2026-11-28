import { redirect } from "next/navigation";

import { SupportEscalationsTable } from "@/components/admin/support-escalations-table";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getDealerForUser } from "@/server/dealers/service";
import { dualVerifyRedirect } from "@/server/dual-auth/policy";
import { escalationTableRows, listEscalations } from "@/server/services/support-escalations";

export const metadata = { title: "Shops needing help" };
export const dynamic = "force-dynamic";

/**
 * 0232 (owner, 28-Nov-2026: "first contact and support from franchisee"): the open items of shops registered with
 * this franchisee's codes — a shop held for review (another owner's shop has the same GSTIN / PAN: approve or reject),
 * a pay-later request, a shop that has not listed products or made a sale 10 days after going live. Not closed in
 * 7 days an item moves to GoKesari's operators, in 10 days to the admin team; the franchisee can still act on it.
 */
export default async function DealerEscalationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/dealer/escalations");
  const verifyAt = await dualVerifyRedirect(user.id, "/dealer/escalations").catch(() => null);
  if (verifyAt) redirect(verifyAt);
  const dealer = await getDealerForUser(user.id);
  if (!dealer || dealer.status === "DRAFT" || dealer.status === "REJECTED") redirect("/dealer");
  const rows = escalationTableRows(await listEscalations({ franchiseeUserId: user.id }), { id: user.id, role: user.role });
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <PageHeader
        title="Shops needing help"
        description="Shops registered with your code that need you: contact the owner and act. An item not closed within 7 days goes to GoKesari's operators, within 10 days to the admin team (you can still act on it). A shop that has not started selling closes by itself once it has products listed and a first delivered order. Times in IST."
        action={<LinkButton href="/dealer" variant="secondary">Dealer page</LinkButton>}
      />
      {rows.length === 0 ? (
        <EmptyState title="Nothing waiting" description="No shop registered with your code needs you right now." />
      ) : (
        <SupportEscalationsTable rows={rows} apiPath="/api/dealer/support-escalations" shopLinks={false} />
      )}
    </div>
  );
}
