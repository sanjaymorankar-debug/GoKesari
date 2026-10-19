import { redirect } from "next/navigation";

import { StatutoryAddForm, StatutoryRowActions } from "@/components/payout-actions";
import { Alert, Badge, Card, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { istDay, listStatutoryRates, STATUTORY_KEYS } from "@/server/statutory/rates";

export const metadata = { title: "Statutory settings" };
export const dynamic = "force-dynamic";

/**
 * Admin → Statutory settings (batch-2026-10 WS-E): GST TCS (s.52), income-tax
 * TDS (s.194-O / s.393), s.9(5) liabilities, rules for unregistered sellers
 * and GST on GoKesari's fees — dated rows, used by the payout maths on each
 * supply's date. Every row shows whether the owner's CA has confirmed it.
 */
export default async function StatutoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.STATUTORY_MANAGE)) redirect("/");
  const rows = await listStatutoryRates();
  const today = istDay(new Date());
  const inForce = (r: (typeof rows)[number]) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today);
  const unconfirmed = rows.filter((r) => !r.confirmedByCa && (!r.effectiveTo || r.effectiveTo >= today)).length;
  const labels = new Map(rows.map((r) => [r.key, r.label]));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Statutory settings"
        description="Tax rates with the dates they apply from. A change applies from its day only, so a payout cycle that spans it uses each supply's own date."
      />
      {unconfirmed > 0 ? (
        <div className="mb-6" data-testid="statutory-unconfirmed">
          <Alert tone="danger" title={`${unconfirmed} setting(s) not confirmed by the CA`}>
            These values were researched, not confirmed. Do not switch on automated payouts or platform invoicing on gokesari.com until the owner&apos;s CA has confirmed every row in force.
          </Alert>
        </div>
      ) : null}

      <Section title="Settings">
        <div className="grid gap-3">
          {rows.map((r) => (
            <Card key={r.id} className={inForce(r) ? "p-4" : "p-4 opacity-75"}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-ink-900">{r.label}</p>
                  <p className="text-xs text-ink-500">
                    {r.key} · from {r.effectiveFrom}
                    {r.effectiveTo ? ` to ${r.effectiveTo}` : " (open)"}
                    {r.rateBp != null ? ` · ${(r.rateBp / 100).toFixed(2)}%` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {inForce(r) ? <Badge tone="info">in force</Badge> : null}
                  <Badge tone={r.enabled ? "success" : "neutral"}>{r.enabled ? "enabled" : "disabled"}</Badge>
                  <Badge tone={r.confirmedByCa ? "success" : "danger"}>{r.confirmedByCa ? "CA confirmed" : "not confirmed by CA"}</Badge>
                </div>
              </div>
              {r.legalReference ? <p className="mt-2 text-sm text-ink-700">{r.legalReference}</p> : null}
              {Object.keys(r.params).length ? <p className="mt-1 break-words font-mono text-xs text-ink-500">{JSON.stringify(r.params)}</p> : null}
              {r.note ? <p className="mt-1 text-xs text-ink-500">{r.note}</p> : null}
              {r.sourceUrl ? (
                <a className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-kesari-700 underline" href={r.sourceUrl} rel="noreferrer noopener" target="_blank">
                  Source
                </a>
              ) : null}
              <StatutoryRowActions id={r.id} enabled={r.enabled} confirmedByCa={r.confirmedByCa} rateBp={r.rateBp} />
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Add a dated change">
        <Card className="p-4">
          <StatutoryAddForm keys={STATUTORY_KEYS.map((key) => ({ key, label: labels.get(key) ?? key }))} />
        </Card>
      </Section>
    </div>
  );
}
