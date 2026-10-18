import { redirect } from "next/navigation";

import { ManufacturerUpload } from "@/components/batch-d/manufacturer-upload";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { MANUFACTURER_TEMPLATE_COLUMNS } from "@/server/pmd/data-sources/manufacturer";
import { manufacturerAccountsForUser } from "@/server/pmd/manufacturers";

export const metadata = { title: "Upload catalogue" };
export const dynamic = "force-dynamic";

/** F9.1.2 — download the template, fill it, upload it. */
export default async function ManufacturerUploadPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [account] = await manufacturerAccountsForUser(user.id);
  if (!account) redirect("/manufacturer");
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Upload your catalogue" description={`${account.name} — one row per product. GTIN, product name and brand are required; we check every GTIN's check digit.`} />
      <div className="flex flex-wrap gap-2">
        <a className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white" href="/api/pmd/manufacturer/template?format=xlsx">Download template (Excel)</a>
        <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-medium" href="/api/pmd/manufacturer/template?format=csv">Template (CSV)</a>
      </div>
      <ManufacturerUpload />
      <details className="rounded-xl border border-cream-200 bg-white p-3 text-sm">
        <summary className="min-h-11 cursor-pointer font-semibold">Columns</summary>
        <ul className="mt-2 space-y-1">
          {MANUFACTURER_TEMPLATE_COLUMNS.map((c) => (
            <li key={c.key}>
              <strong>{c.header}</strong>
              {c.required ? " (required)" : ""} — {c.help || "optional"}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-500">Bulk upload by API: POST /api/pmd/v1/manufacturer/products with your API key (Authorization: Bearer …), JSON {"{ products: [...] }"} or the CSV.</p>
      </details>
    </div>
  );
}
