import { redirect } from "next/navigation";

import { GstConfigEditor } from "@/components/admin/gst-config-editor";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { GST_RULE_HELP, listGstRules, listHsnRates } from "@/server/gst/config";
import { istDate } from "@/server/gst/rules";

export const metadata = { title: "GST settings" };
export const dynamic = "force-dynamic";

/** Module 2: GST thresholds, numbering and fallback rates as dated data (admin only). */
export default async function GstConfigPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.GST_CONFIG_MANAGE)) redirect("/");
  const [rules, rates] = await Promise.all([listGstRules(), listHsnRates()]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="GST settings"
        description="Thresholds and switches by date: a change applies from the day you choose; invoices already issued keep the rule of their date. Confirm values with the CA. Every change is in the audit log."
      />
      <GstConfigEditor rules={JSON.parse(JSON.stringify(rules))} help={GST_RULE_HELP} rates={JSON.parse(JSON.stringify(rates))} today={istDate(new Date())} />
    </div>
  );
}
