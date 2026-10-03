import { redirect } from "next/navigation";

import { DisputeQueue } from "@/components/dispute-queue";
import { PageHeader } from "@/components/ui";
import { DISPUTE_STATUSES, type DisputeStatus } from "@/lib/dispute-states";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { countDisputes, listDisputes } from "@/server/services/disputes";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Disputes" };
export const dynamic = "force-dynamic";

/**
 * Dispute cases (GS-058). The fraud queue is /admin/risk and returns are
 * /admin/returns; this is the one for "the customer says the order was wrong".
 */
export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; level?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DISPUTE_MANAGE)) redirect("/");

  const params = await searchParams;
  const status = DISPUTE_STATUSES.find((s) => s === params.status) as DisputeStatus | undefined;
  const level = params.level === "L1" || params.level === "L2" ? params.level : undefined;
  const filtered = Boolean(status || level);

  const [rows, counts, rules] = await Promise.all([
    listDisputes({ status, level, liveOnly: !status, limit: 200 }),
    countDisputes(),
    getRule("disputes"),
  ]);

  const escalation = [
    rules.escalateAfterHours > 0
      ? `escalates after ${rules.escalateAfterHours} h`
      : "no age escalation",
    rules.escalateAbovePaise > 0
      ? `or at ₹${(rules.escalateAbovePaise / 100).toLocaleString("en-IN")} and above`
      : "no amount escalation",
  ].join(", ");

  return (
    <>
      <PageHeader
        title="Disputes"
        description={`${counts.live} open · ${counts.escalated} escalated · ${counts.overdue} past the ${rules.resolveTargetHours} h resolve target. Automatic: ${escalation}. An escalated case can only be taken forward by an administrator.`}
      />
      <DisputeQueue
        rows={rows.map((r) => ({
          id: r.id,
          caseNumber: r.caseNumber,
          orderNumber: r.orderNumber,
          status: r.status,
          level: r.level,
          reason: r.reason,
          disputedAmountPaise: r.disputedAmountPaise,
          paymentMethod: r.paymentMethodSnapshot,
          escalationTrigger: r.escalationTrigger,
          raisedByName: r.raisedByName,
          createdAt: r.createdAt.toISOString(),
        }))}
        activeStatus={status ?? null}
        activeLevel={level ?? null}
        filtered={filtered}
        isAdmin={user.role === "ADMIN"}
        canRefund={can(user.role, PERMISSIONS.ORDER_REFUND)}
      />
    </>
  );
}
