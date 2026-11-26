import Link from "next/link";
import { redirect } from "next/navigation";

import { SendResumeLinkButton } from "@/components/registration/admin-actions";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listUnfinishedRegistrations } from "@/server/registration/unfinished";

export const metadata = { title: "Unfinished shop registrations" };
export const dynamic = "force-dynamic";

const STEP: Record<string, string> = {
  REFERRAL: "Referral code",
  IDENTITY: "Verify GST / PAN",
  TYPE: "Shop type",
  LICENCES: "Licences",
  EMAIL: "Shop e-mail",
  OWNER: "Owner name",
  ADDRESS: "Address",
  PIN: "Map pin",
  SHOP: "Shop details",
  REVIEW: "Review",
  DOCUMENTS: "Documents",
  PAYMENT: "Pay the fee",
  // docs/onboarding-v2-2026-11 (Flow 2).
  V2_IDENTITY: "Verify mobile / e-mail",
  FEE: "Pay the fee (pending payment)",
  V2_LICENCES: "Licences",
  SLA: "Seller agreement",
};
const idle = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} d` : `${h} h`);

/**
 * Owner, 25-Nov-2026: every unfinished or abandoned shop registration, with the step it stopped on.
 * Staff continue it for the owner, or send the owner a link; it always resumes where it stopped.
 */
export default async function UnfinishedRegistrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const only = (["ALL", "ACTIVE", "ABANDONED"] as const).find((s) => s === params.only) ?? "ALL";
  const rows = await listUnfinishedRegistrations({ search: q, only });
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Unfinished shop registrations"
        description="Registrations not finished yet, including abandoned ones (no step for 7 days). Continue one for the owner, or send the owner a link: it opens again at the step it stopped on. The GST / PAN consent needs the owner's agreement, and the owner pays the fee."
      />
      <form className="flex flex-wrap items-center gap-2 text-sm" data-testid="unfinished-filter">
        <input name="q" defaultValue={q} placeholder="Name, e-mail, phone or business" className="min-h-11 flex-1 rounded-lg border border-cream-300 px-3" />
        <input type="hidden" name="only" value={only} />
        <button className="min-h-11 rounded-lg bg-kesari-600 px-4 font-semibold text-white">Search</button>
      </form>
      <div className="flex gap-2 text-sm">
        {(["ALL", "ACTIVE", "ABANDONED"] as const).map((s) => (
          <a key={s} href={`?only=${s}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`rounded-full px-3 py-1 ${s === only ? "bg-kesari-600 text-white" : "bg-cream-100"}`}>
            {s === "ALL" ? "All" : s === "ACTIVE" ? "In progress" : "Abandoned"}
          </a>
        ))}
      </div>
      <Card className="overflow-x-auto p-0" data-testid="unfinished-registrations">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500">
            <tr>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Business</th>
              <th className="px-3 py-2">Stopped at</th>
              <th className="px-3 py-2 text-right">Idle</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.draftId}>
                <td className="px-3 py-2">
                  {r.ownerName ?? "—"}
                  <span className="block text-xs text-ink-500">{r.ownerEmail}</span>
                  {r.ownerPhone ? <a href={`tel:${r.ownerPhone}`} className="block text-xs text-kesari-800 underline">{r.ownerPhone}</a> : null}
                </td>
                <td className="px-3 py-2">
                  {r.business ?? "—"}
                  <span className="block font-mono text-xs text-ink-500">{r.number ?? "no GST / PAN yet"}</span>
                  {r.city ? <span className="block text-xs text-ink-500">{r.city}</span> : null}
                </td>
                <td className="px-3 py-2">
                  {r.status === "SUBMITTED" ? "Pay the fee" : STEP[r.step ?? ""] ?? r.step ?? "Verify GST / PAN"}{" "}
                  {r.abandoned ? <Badge tone="warning">abandoned</Badge> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{idle(r.idleHours)}</td>
                <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                  {r.status !== "SUBMITTED" ? (
                    <Link href={`/admin/shop-registrations/unfinished/${r.draftId}`} className="inline-flex min-h-9 items-center rounded-lg bg-kesari-600 px-3 text-sm font-semibold text-white" data-testid="continue-registration">
                      Continue for owner
                    </Link>
                  ) : null}
                  <SendResumeLinkButton draftId={r.draftId} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-ink-500">None.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
