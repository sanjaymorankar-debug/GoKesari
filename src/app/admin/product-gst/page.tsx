import Link from "next/link";
import { redirect } from "next/navigation";

import { ProductGstEditor } from "@/components/admin/product-gst-editor";
import { Button, inputClass, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listProductGstRates, STANDARD_GST_RATES } from "@/server/gst/product-rates";

export const metadata = { title: "Product GST rates" };
export const dynamic = "force-dynamic";

/** Master products' own HSN code and GST rate (admin only); see server/gst/product-rates.ts. */
export default async function ProductGstPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.GST_CONFIG_MANAGE)) redirect("/");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 80) : "";
  const missing = sp.missing === "1";
  const { rows, missingTotal } = await listProductGstRates({ q: q || undefined, missing, limit: 100 });
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Product GST rates"
        description="Each product's own HSN code and GST rate. A shop's own rate (from its accounting software or a supplier bill) still wins on that shop's invoices. A change applies to invoices issued from now on; issued invoices keep their rate. For a change that starts on a later date, use the dated HSN table in GST settings. Confirm rates with the CA; every change is in the audit log."
        action={<Link href="/admin/gst-config" className="text-sm font-medium text-kesari-700 hover:underline">GST settings →</Link>}
      />
      <form method="get" className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Product name, barcode or HSN" aria-label="Search products" className={`${inputClass} max-w-xs`} />
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" name="missing" value="1" defaultChecked={missing} /> Only products with no rate ({missingTotal})
        </label>
        <Button type="submit" size="sm">Search</Button>
      </form>
      <ProductGstEditor rows={rows} standardRates={[...STANDARD_GST_RATES]} />
      {rows.length === 100 ? <p className="mt-3 text-xs text-ink-500">Showing the first 100 — narrow the search to see others.</p> : null}
    </div>
  );
}
