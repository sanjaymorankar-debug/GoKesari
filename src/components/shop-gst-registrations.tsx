"use client";

/**
 * Many GSTINs per shop (owner, 25-Nov-2026): the main GSTIN and the shop's GSTINs for other
 * states. The owner adds one (checked with the government record at once) or removes it; staff
 * see the list and may remove one. An order delivered in a state listed here is invoiced under
 * that state's GSTIN; every other order keeps the main GSTIN.
 */
import { useState, type FormEvent } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";
import type { ShopGstRegistrationsView } from "@/server/services/shop-gst-registrations";

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING: { label: "Not verified yet", tone: "warning" },
  MANUAL_REVIEW: { label: "Being checked", tone: "warning" },
  FAILED: { label: "Not verified", tone: "danger" },
};

export function ShopGstRegistrations({ shopId, initial, mode }: { shopId: string; initial: ShopGstRegistrationsView; mode: "owner" | "staff" }) {
  const [view, setView] = useState(initial);
  const [gstin, setGstin] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function call(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    setFieldError(null);
    const res = await fetch(url, init).catch(() => null);
    setBusy(false);
    const body = res ? await res.json().catch(() => null) : null;
    if (!res?.ok) {
      setError(body?.error?.message ?? "Could not save. Please try again.");
      setFieldError(body?.error?.details?.fields?.gstin ?? null);
      return false;
    }
    setView((body?.data ?? body) as ShopGstRegistrationsView);
    return true;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await call(`/api/shops/${shopId}/gst-registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gstin: gstin.trim().toUpperCase(), consent }),
    });
    if (ok) {
      setGstin("");
      setConsent(false);
    }
  }

  async function remove(id: string, masked: string) {
    if (!window.confirm(`Remove GSTIN ${masked}? Later invoices for that state use your main GSTIN.`)) return;
    await call(`/api/shops/${shopId}/gst-registrations/${id}`, { method: "DELETE" });
  }

  return (
    <Card className="grid gap-3 p-4" data-testid="shop-gst-registrations">
      <div>
        <h2 className="text-base font-bold text-ink-900">GST registrations in other states</h2>
        <p className="text-sm text-ink-600">
          A business registered in several states has one GSTIN per state. An order delivered in a state listed here is invoiced under that
          state&apos;s GSTIN and outlet address; every other order uses your main GSTIN.
        </p>
      </div>
      <p className="text-sm text-ink-700" data-testid="main-gstin">
        Main GSTIN:{" "}
        {view.main.gstin ? (
          <>
            <span className="font-mono">{view.main.gstin}</span>
            {view.main.stateName ? ` (${view.main.stateName})` : null}
          </>
        ) : (
          "none"
        )}
      </p>
      {view.registrations.length > 0 ? (
        <ul className="divide-y divide-[var(--gk-line)] rounded-xl border border-[var(--gk-line)]" data-testid="gst-registration-list">
          {view.registrations.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm">
              <div className="space-y-0.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{r.gstinMasked}</span>
                  <span className="text-ink-600">{r.stateName ?? r.stateCode}</span>
                  <Badge tone={STATUS[r.status]?.tone ?? "warning"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                </p>
                {r.legalName ? <p className="text-ink-800">{r.legalName}</p> : null}
                {r.outletAddress ? <p className="text-ink-600">{r.outletAddress}</p> : null}
                {r.message ? <p className="text-ink-600">{r.message}</p> : null}
              </div>
              <Button type="button" variant="ghost" onClick={() => void remove(r.id, r.gstinMasked)} disabled={busy} data-testid="remove-gst-registration">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-600">No other GSTINs added.</p>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {mode === "owner" ? (
        view.canAdd ? (
          <form onSubmit={add} className="grid gap-3" data-testid="add-gst-registration">
            <Field label="GSTIN of another state (15 characters)" error={fieldError ?? undefined}>
              <input
                className={`${inputClass} font-mono uppercase`}
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase())}
                maxLength={15}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="29ABCDE1234F1Z5"
                data-testid="extra-gstin-input"
              />
            </Field>
            <label className="flex items-start gap-3 text-sm text-ink-700">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I agree that GoKesari checks this number with the government record.
                <details className="text-xs text-ink-600">
                  <summary className="cursor-pointer underline">Read in full</summary>
                  <p className="mt-1">{SELLER_VERIFICATION_CONSENT_TEXT}</p>
                </details>
              </span>
            </label>
            <div>
              <Button type="submit" disabled={busy || !consent || gstin.trim().length !== 15} data-testid="verify-extra-gstin">
                {busy ? "Verifying…" : "Verify and add GSTIN"}
              </Button>
            </div>
          </form>
        ) : view.blockedReason ? (
          <Alert tone="info">{view.blockedReason}</Alert>
        ) : null
      ) : null}
    </Card>
  );
}
