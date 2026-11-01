"use client";

/**
 * Billing v2 (docs/billing §3.1): the shop's GST registration type. A shop
 * with a GSTIN follows it; one without declares an Enrolment ID or that it
 * is a PAN-only service provider.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

type Declared = "BY_GSTIN" | "ENROLMENT_ID" | "PAN_ONLY_SERVICE";

const TYPE_LABEL: Record<string, string> = {
  REGULAR: "Regular GST registration",
  COMPOSITION: "Composition scheme",
  ENROLMENT_ID: "GST Enrolment ID (unregistered seller of goods)",
  PAN_ONLY_SERVICE: "PAN-only service provider",
  UNREGISTERED: "Not registered under GST",
};

export function GstRegistrationType({ shopId, initial }: { shopId: string; initial: { type: string; declared: Declared; enrolmentId: string | null; hasGstin: boolean } }) {
  const router = useRouter();
  const [declared, setDeclared] = useState<Declared>(initial.declared);
  const [enrolmentId, setEnrolmentId] = useState(initial.enrolmentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/shops/${shopId}/accounts/gst-registration`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: declared, enrolmentId: declared === "ENROLMENT_ID" ? enrolmentId : null }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not save.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="grid gap-3 p-4" data-testid="gst-registration-type">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold text-ink-900">GST registration type</h2>
        <Badge tone="info">{TYPE_LABEL[initial.type] ?? initial.type}</Badge>
      </div>
      {initial.hasGstin ? (
        <p className="text-sm text-ink-600">Your shop has a GSTIN, so this follows it: regular or composition, as verified.</p>
      ) : (
        <>
          <p className="text-sm text-ink-600">Without a GSTIN, tell us how you sell. An Enrolment ID lets you sell goods within your state through GoKesari; no TCS is collected from you.</p>
          <fieldset className="grid gap-1.5 text-sm">
            {(
              [
                ["BY_GSTIN", "Not registered (no GSTIN, no Enrolment ID)"],
                ["ENROLMENT_ID", "I have a GST Enrolment ID"],
                ["PAN_ONLY_SERVICE", "I provide services (PAN only)"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-2">
                <input type="radio" name="gst-registration" checked={declared === value} onChange={() => setDeclared(value)} />
                {label}
              </label>
            ))}
          </fieldset>
          {declared === "ENROLMENT_ID" ? (
            <Field label="Enrolment ID">
              <input aria-label="Enrolment ID" className={inputClass} maxLength={15} value={enrolmentId} onChange={(e) => setEnrolmentId(e.target.value.toUpperCase())} />
            </Field>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {saved ? <Alert tone="success">Saved.</Alert> : null}
          <div>
            <Button disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
