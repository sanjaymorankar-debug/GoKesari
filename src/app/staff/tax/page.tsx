import { redirect } from "next/navigation";

import { TaxRegisterDesk } from "@/components/staff/tax-register-desk";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { listCaItems } from "@/server/tax-register/ca-items";
import { listTaxChanges, listTaxParameters } from "@/server/tax-register/changes";
import { TAX_RULE_FIELDS } from "@/server/tax-register/rules";

export const metadata = { title: "Tax register" };
export const dynamic = "force-dynamic";

const ist = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : null;

/**
 * docs/tax-register: the Accountant proposes changes to tax settings and answers questions for
 * the CA; the CA approves or sends back. Admins see everything and may propose, never approve.
 */
export default async function TaxRegisterPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const canPropose = can(user.role, PERMISSIONS.TAX_PARAM_PROPOSE);
  const canApprove = user.role === "CA" && can(user.role, PERMISSIONS.TAX_PARAM_APPROVE);
  if (!canPropose && !canApprove) redirect("/");
  const { tab } = await searchParams;
  const [parameters, changes, ca, enforced] = await Promise.all([listTaxParameters(), listTaxChanges(), listCaItems({ id: user.id, role: user.role }), isFeatureEnabled("tax_register")]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Tax register"
        description={
          enforced
            ? "Tax settings change only here: the Accountant proposes, the CA approves (never their own), and the change is applied at once."
            : "The Accountant proposes, the CA approves. The admin screens can still edit tax settings directly until the tax_register flag is switched on."
        }
      />
      <TaxRegisterDesk
        tab={tab ?? (canApprove ? "changes" : "settings")}
        me={{ id: user.id, role: user.role, canPropose, canApprove }}
        ruleFields={TAX_RULE_FIELDS as unknown as Record<string, string[]>}
        parameters={parameters.map((p) => ({ ...p, approvedAtIst: ist(p.approvedAt), approvedAt: undefined }))}
        changes={changes.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          status: c.status,
          reason: c.reason,
          legalReference: c.legalReference,
          payload: c.payload,
          currentValue: c.currentValue,
          proposedBy: c.proposedBy,
          proposedRole: c.proposedRole,
          decisionNote: c.decisionNote,
          applyError: c.applyError,
          createdIst: ist(c.createdAt)!,
          decidedIst: ist(c.decidedAt),
        }))}
        items={ca.items.map((i) => ({
          id: i.id,
          ref: i.ref,
          area: i.area,
          title: i.title,
          question: i.question,
          blocks: i.blocks,
          status: i.status,
          priority: i.priority,
          dueOn: i.dueOn,
          answer: i.answer,
          answeredBy: i.answeredBy,
          approvedIst: ist(i.approvedAt),
          notes: i.notes.map((n) => ({ id: n.id, kind: n.kind, body: n.body, authorRole: n.authorRole, atIst: ist(n.createdAt)! })),
        }))}
        switches={ca.switches}
      />
    </div>
  );
}
