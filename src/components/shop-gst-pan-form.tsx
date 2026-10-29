"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { parseGstin } from "@/lib/shop-identity";
import type { GstStatus, PanStatus } from "@/server/db/schema";

export interface ShopGstPanSettings {
  shopId: string;
  gstStatus: GstStatus;
  gstin: string | null;
  panStatus: PanStatus;
  panMasked: string | null;
  /** Copied onto the shop once verified (Documents page); shown here read-only. */
  udyamNumber?: string | null;
  shopActNumber?: string | null;
}

const GST_STATUS_TONE: Record<GstStatus, "success" | "warning" | "danger" | "neutral"> = {
  REGISTERED: "success",
  NOT_REGISTERED: "neutral",
  PENDING_VERIFICATION: "warning",
  COMPOSITION: "success",
  VERIFICATION_FAILED: "danger",
  UNKNOWN: "neutral",
};

const GST_STATUS_LABEL: Record<GstStatus, string> = {
  REGISTERED: "Verified",
  NOT_REGISTERED: "Not registered",
  PENDING_VERIFICATION: "Pending review",
  COMPOSITION: "Composition scheme",
  VERIFICATION_FAILED: "Verification failed",
  UNKNOWN: "Not submitted",
};

const PAN_STATUS_TONE: Record<PanStatus, "success" | "warning" | "danger" | "neutral"> = {
  VERIFIED: "success",
  PENDING_VERIFICATION: "warning",
  VERIFICATION_FAILED: "danger",
  UNKNOWN: "neutral",
};

const PAN_STATUS_LABEL: Record<PanStatus, string> = {
  VERIFIED: "Verified",
  PENDING_VERIFICATION: "Pending review",
  VERIFICATION_FAILED: "Verification failed",
  UNKNOWN: "Not submitted",
};

/**
 * Self-service GST/PAN submission (marketplace GST-readiness follow-up).
 * No automated verification provider is configured yet, so a submission
 * goes to PENDING_VERIFICATION for an admin to confirm by hand — this form
 * never claims something is verified that hasn't actually been checked.
 */
export function ShopGstPanForm({ settings }: { settings: ShopGstPanSettings }) {
  const router = useRouter();
  const [gstin, setGstin] = useState(settings.gstin ?? "");
  const [panNumber, setPanNumber] = useState("");
  const [panHolderName, setPanHolderName] = useState("");
  const [busy, setBusy] = useState<"gst" | "gst-none" | "pan" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitGstin() {
    // The server's own check, run here first so a typo is caught before sending (TC-FLD-043).
    const parsed = parseGstin(gstin);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy("gst");
    setError(null);
    const response = await fetch(`/api/shops/${settings.shopId}/gst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gstin: parsed.value }),
    });
    setBusy(null);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not submit the GSTIN.");
      return;
    }
    router.refresh();
  }

  async function declareNoGstin() {
    setBusy("gst-none");
    setError(null);
    const response = await fetch(`/api/shops/${settings.shopId}/gst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notRegistered: true }),
    });
    setBusy(null);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save this.");
      return;
    }
    router.refresh();
  }

  async function submitPan() {
    setBusy("pan");
    setError(null);
    const response = await fetch(`/api/shops/${settings.shopId}/pan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        panNumber: panNumber.trim().toUpperCase(),
        holderName: panHolderName.trim(),
      }),
    });
    setBusy(null);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not submit the PAN.");
      return;
    }
    setPanNumber("");
    setPanHolderName("");
    router.refresh();
  }

  const gstDecided = settings.gstStatus !== "UNKNOWN";

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-lg font-semibold text-ink-900">GST &amp; PAN</h2>

      <div className="space-y-5">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <p className="text-sm font-medium text-ink-700">GST registration</p>
            <Badge tone={GST_STATUS_TONE[settings.gstStatus]}>
              {GST_STATUS_LABEL[settings.gstStatus]}
            </Badge>
          </div>

          {!gstDecided ? <p className="mb-2 text-xs text-ink-500">Do you have a GSTIN?</p> : null}

          {settings.gstStatus !== "REGISTERED" && settings.gstStatus !== "COMPOSITION" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Field label="GSTIN">
                  <input
                    className={inputClass}
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    placeholder="27ABCDE1234F1Z0"
                    maxLength={15}
                  />
                </Field>
              </div>
              <Button disabled={busy === "gst" || gstin.trim().length !== 15} onClick={submitGstin}>
                {busy === "gst" ? "Submitting…" : settings.gstin ? "Update GSTIN" : "Submit GSTIN"}
              </Button>
              {!gstDecided ? (
                <Button variant="secondary" disabled={busy === "gst-none"} onClick={declareNoGstin}>
                  {busy === "gst-none" ? "Saving…" : "No, I'm not GST registered"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {settings.gstStatus === "PENDING_VERIFICATION" ? (
            <p className="mt-2 text-xs text-ink-500">
              Submitted — an admin will confirm this shortly.
            </p>
          ) : null}
          {settings.gstStatus === "VERIFICATION_FAILED" ? (
            <p className="mt-2 text-xs text-red-700">
              This GSTIN could not be verified. Double-check it and submit again.
            </p>
          ) : null}
        </div>

        <div className="border-t border-cream-200 pt-4">
          <div className="mb-1 flex items-center gap-2">
            <p className="text-sm font-medium text-ink-700">PAN</p>
            <Badge tone={PAN_STATUS_TONE[settings.panStatus]}>
              {PAN_STATUS_LABEL[settings.panStatus]}
            </Badge>
          </div>
          {settings.panMasked ? (
            <p className="mb-2 text-sm text-ink-600">{settings.panMasked}</p>
          ) : null}

          {settings.panStatus !== "VERIFIED" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px]">
                <Field label="PAN number">
                  <input
                    className={inputClass}
                    value={panNumber}
                    onChange={(e) => setPanNumber(e.target.value.toUpperCase())}
                    placeholder="AAAAA9999A"
                    maxLength={10}
                  />
                </Field>
              </div>
              <div className="min-w-[220px] flex-1">
                <Field label="Name on PAN card">
                  <input
                    className={inputClass}
                    value={panHolderName}
                    onChange={(e) => setPanHolderName(e.target.value)}
                    placeholder="As printed on the card"
                  />
                </Field>
              </div>
              <Button
                disabled={busy === "pan" || panNumber.trim().length !== 10 || !panHolderName.trim()}
                onClick={submitPan}
              >
                {busy === "pan" ? "Submitting…" : settings.panMasked ? "Update PAN" : "Submit PAN"}
              </Button>
            </div>
          ) : null}

          {settings.panStatus === "PENDING_VERIFICATION" ? (
            <p className="mt-2 text-xs text-ink-500">
              Submitted — an admin will confirm this shortly.
            </p>
          ) : null}
          {settings.panStatus === "VERIFICATION_FAILED" ? (
            <p className="mt-2 text-xs text-red-700">
              This PAN could not be verified. Double-check it and submit again.
            </p>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid gap-2 border-t border-ink-100 pt-3 text-sm sm:grid-cols-2" data-testid="other-registrations">
        <div>
          <dt className="text-ink-600">Udyam registration</dt>
          <dd className="font-medium text-ink-900">{settings.udyamNumber ?? "Not on file"}</dd>
        </div>
        <div>
          <dt className="text-ink-600">Shop Act licence</dt>
          <dd className="font-medium text-ink-900">{settings.shopActNumber ?? "Not on file"}</dd>
        </div>
        <p className="text-xs text-ink-500 sm:col-span-2">
          Verified on the <a className="underline" href="/shop/documents">Documents</a> page; add or change them there.
        </p>
      </dl>

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
