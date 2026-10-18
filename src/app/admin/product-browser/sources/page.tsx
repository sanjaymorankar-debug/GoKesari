import { redirect } from "next/navigation";

import { SourceLookupForm } from "@/components/batch-d/source-lookup-form";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { gs1DataSource } from "@/server/pmd/data-sources/gs1-datakart";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Product data sources" };
export const dynamic = "force-dynamic";

/** F9.1.2 — GS1 India DataKart and Open Food Facts look-ups (both switched on in Settings → pmdSources). */
export default async function SourcesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_IMPORT)) redirect("/");
  const rules = await getRule("pmdSources");
  const gs1 = gs1DataSource();
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="GS1 / Open Food Facts" description="Look up barcodes and stage what the source knows. Records are de-duplicated by GTIN like every import." />
      {gs1.mode() === "MOCK" ? (
        <Alert tone="warning" title="GS1 DataKart is a mock here">
          Until GS1_DATAKART_BASE_URL and GS1_DATAKART_API_KEY are set, look-ups return GoKesari test records (source gs1_datakart_mock), never GS1 data. The mock never runs in production.
        </Alert>
      ) : null}
      <Alert tone="info" title="Open Food Facts licence">
        Open Food Facts data is under the Open Database License (ODbL 1.0) and its images under CC BY-SA. The attribution is stored with every record and shown in the product browser.
      </Alert>
      <SourceLookupForm gs1={{ enabled: rules.gs1Enabled && gs1.mode() !== "UNAVAILABLE", mode: gs1.mode() }} off={{ enabled: rules.openFoodFactsEnabled }} />
    </div>
  );
}
