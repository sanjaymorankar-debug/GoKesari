import { redirect } from "next/navigation";

import { PlatformSettingsEditor } from "@/components/platform-settings-editor";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listRules } from "@/server/services/settings";

export const metadata = { title: "Business rules" };
export const dynamic = "force-dynamic";

/** Every configurable business rule with its default and current value (admin only). */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const rules = await listRules();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Business rules"
        description="Limits, retries, policies and windows that are adjustable without a release. Changes are validated, take effect within seconds, and are recorded in the audit log."
      />
      <PlatformSettingsEditor
        rules={rules.map((r) => ({ key: r.key, description: r.description, defaults: r.defaults, value: r.value, overridden: r.overridden }))}
      />
    </div>
  );
}
