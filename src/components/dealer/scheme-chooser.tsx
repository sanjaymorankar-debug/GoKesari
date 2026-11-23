"use client";

/**
 * docs/dealer-platform phase 2: the applicant compares the published dealership schemes, chooses one and pays its
 * joining charge (free schemes skip payment). The franchise (zone booking) is linked, not chosen here.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SchemeTermsPanel } from "@/components/dealer/scheme-terms";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type { SchemeTerms } from "@/lib/dealer-schemes";

export interface ChooserScheme {
  code: string;
  name: string;
  versionId: string;
  version: number;
  termsHash: string;
  terms: SchemeTerms;
  totals: { basePaise: number; gstPaise: number; totalPaise: number };
}

export interface ChooserCharge {
  required: boolean;
  totalPaise: number;
  status: string | null;
  paidAt: string | null;
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function SchemeChooser({ schemes, chosenVersionId, charge, editable }: { schemes: ChooserScheme[]; chosenVersionId: string | null; charge: ChooserCharge | null; editable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = schemes.find((s) => s.versionId === chosenVersionId) ?? null;
  const paid = charge?.status === "PAID";

  async function call(url: string, body: unknown, label: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function choose(versionId: string) {
    if (await call("/api/dealer/application/scheme", { versionId }, `choose-${versionId}`)) router.refresh();
  }

  async function pay() {
    const p = await call("/api/dealer/application/scheme/pay", {}, "pay");
    if (p?.checkoutUrl) window.location.assign(p.checkoutUrl);
    else if (p) router.refresh();
  }

  return (
    <Card className="space-y-3 p-4" data-testid="dealer-scheme-chooser">
      <h2 className="text-base font-bold text-ink-900">Choose your scheme</h2>
      <p className="text-sm text-ink-700">
        Compare the schemes and choose one. Your scheme&apos;s terms are fixed for you when you are approved: later changes by GoKesari do not change them. Want a franchise zone of
        your own instead? <a className="underline" href="/franchise">Book a franchise zone</a>.
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {schemes.map((s) => {
          const isChosen = s.versionId === chosenVersionId;
          return (
            <div key={s.versionId} className={`rounded-lg border p-3 ${isChosen ? "border-kesari-600 ring-2 ring-kesari-200" : "border-cream-200"}`} data-testid={`scheme-option-${s.code}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-ink-900">{s.name}</h3>
                {isChosen ? <Badge tone="success">chosen</Badge> : null}
                <span className="ml-auto text-sm font-semibold text-ink-900">{s.totals.totalPaise ? rupees(s.totals.totalPaise) : "Free"}</span>
              </div>
              <div className="mt-2">
                <SchemeTermsPanel terms={s.terms} />
              </div>
              {editable && !isChosen ? (
                <Button className="mt-3" variant="secondary" disabled={busy !== null || (paid && !isChosen)} onClick={() => choose(s.versionId)}>
                  {busy === `choose-${s.versionId}` ? "Choosing…" : `Choose ${s.name}`}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {chosen && charge?.required ? (
        <div className="rounded-lg bg-cream-50 p-3 text-sm" data-testid="dealer-joining-charge">
          {paid ? (
            <p>
              <Badge tone="success">Paid</Badge> Joining charge of {rupees(charge.totalPaise)} received{charge.paidAt ? ` on ${new Date(charge.paidAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}. You can submit
              your application.
            </p>
          ) : (
            <>
              <p>
                {chosen.name} has a joining charge of <span className="font-semibold">{rupees(charge.totalPaise)}</span> (including GST), paid online before you submit. If your
                application is not approved, it is refunded to the way you paid.
              </p>
              {editable ? (
                <Button className="mt-2" disabled={busy !== null} onClick={pay}>
                  {busy === "pay" ? "Opening payment…" : `Pay ${rupees(charge.totalPaise)}`}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
