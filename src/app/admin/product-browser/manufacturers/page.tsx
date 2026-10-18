import { redirect } from "next/navigation";

import { ManufacturerAdmin } from "@/components/batch-d/manufacturer-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listManufacturerAccounts } from "@/server/pmd/manufacturers";

export const metadata = { title: "Manufacturers" };
export const dynamic = "force-dynamic";

/** F9.1.2 — manufacturer accounts for the self-upload portal (/manufacturer). Admin only. */
export default async function ManufacturersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_MANUFACTURER_MANAGE)) redirect("/");
  const accounts = await listManufacturerAccounts();
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Manufacturers" description="A brand owner that supplies its own catalogue. Its people upload at /manufacturer or with an API key." />
      <ManufacturerAdmin accounts={JSON.parse(JSON.stringify(accounts))} />
    </div>
  );
}
