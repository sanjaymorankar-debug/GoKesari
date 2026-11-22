import { redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { photoListingReport } from "@/server/services/shop-photo-listing";

export const metadata = { title: "Products added by photo" };
export const dynamic = "force-dynamic";

const OUTCOMES: Record<string, string> = {
  LINKED_MASTER: "Linked to a catalogue product",
  UPDATED_LISTING: "Already listed: price/stock updated",
  REUSED_EXISTING: "Same name already in catalogue: reused",
  CREATED_PENDING: "New product, waiting for review",
  CREATED_APPROVED: "New product (added by staff)",
};

/** docs/smart-shopping-2026-11 (Feature 2): products added by photo + voice, and AI accuracy (fields kept vs changed). */
export default async function PhotoListingReportPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PRODUCT_APPROVE)) redirect("/admin");
  const days = Math.min(365, Math.max(1, Number((await searchParams).days) || 30));
  const r = await photoListingReport(days);
  const stat = (label: string, value: string | number) => (
    <Card>
      <p className="text-xs text-ink-500">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </Card>
  );
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Products added by photo" description={`Last ${days} days. AI accuracy = fields the owner kept ÷ fields kept or changed, on published products.`} />
      <div className="flex gap-2 text-sm">
        {[7, 30, 90].map((d) => (
          <a key={d} href={`?days=${d}`} className={d === days ? "font-semibold underline" : "text-kesari-700"}>
            {d} days
          </a>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Photo reads", r.shots)}
        {stat("Published", r.published)}
        {stat("Unreadable (retake)", r.unreadable)}
        {stat("AI accuracy", r.accuracyPct === null ? "—" : `${r.accuracyPct}%`)}
        {stat("Shops", r.shops)}
        {stat("Fields kept", r.fieldsKept)}
        {stat("Fields changed", r.fieldsChanged)}
        {stat("AI cost (USD, est.)", (r.aiCostMicros / 1e6).toFixed(2))}
      </div>
      <Card>
        <h2 className="mb-2 font-semibold">Published, by result</h2>
        <ul className="text-sm">
          {Object.entries(r.byOutcome).map(([k, n]) => (
            <li key={k}>
              {OUTCOMES[k] ?? k}: <strong>{n}</strong>
            </li>
          ))}
          {Object.keys(r.byOutcome).length === 0 ? <li className="text-ink-500">None yet.</li> : null}
        </ul>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Fields owners corrected most</h2>
        <ul className="text-sm">
          {r.changedByField.map((f) => (
            <li key={f.field}>
              {f.field}: <strong>{f.changed}</strong>
            </li>
          ))}
          {r.changedByField.length === 0 ? <li className="text-ink-500">None yet.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
