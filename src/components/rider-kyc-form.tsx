"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { RIDER_KYC_CONSENT_TEXT, RIDER_KYC_STATUS_LABELS, type RiderKycStatus } from "@/lib/gig/kyc";

export interface KycCheckProps {
  status: RiderKycStatus;
  numberMasked: string;
  reason: string | null;
  awaitingOtp: boolean;
}

const TONE: Record<RiderKycStatus, "success" | "warning" | "danger"> = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" };

function StatusLine({ check }: { check: KycCheckProps | null }) {
  if (!check) return <Badge>Not started</Badge>;
  return (
    <div className="space-y-1" data-testid="kyc-status">
      <div className="flex items-center gap-2">
        <Badge tone={TONE[check.status]}>{RIDER_KYC_STATUS_LABELS[check.status]}</Badge>
        <span className="font-mono text-sm text-ink-700">{check.numberMasked}</span>
      </div>
      {check.reason ? <p className="text-xs text-ink-500">{check.reason}</p> : null}
    </div>
  );
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; message: string | null; fields: Record<string, string> }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return { ok: true, message: null, fields: {} };
    const payload = await response.json().catch(() => null);
    return { ok: false, message: payload?.error?.message ?? "Something went wrong. Try again.", fields: payload?.error?.details?.fields ?? {} };
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again.", fields: {} };
  }
}

/**
 * Gig worker flow (feature 2): consent, then PAN and Aadhaar (by OTP to the
 * Aadhaar-linked mobile). Shows Verified / Pending / Failed with the masked
 * number only; the full numbers never come back from the server.
 */
export function RiderKycForm({ pan, aadhaar }: { pan: KycCheckProps | null; aadhaar: KycCheckProps | null }) {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<null | "pan" | "otp" | "verify">(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [panInput, setPanInput] = useState("");
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [otp, setOtp] = useState("");

  async function run(kind: "pan" | "otp" | "verify", url: string, body: unknown, after?: () => void) {
    setBusy(kind);
    setError(null);
    setFields({});
    const result = await post(url, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      setFields(result.fields);
      return;
    }
    after?.();
    router.refresh();
  }

  const panDone = pan?.status === "VERIFIED";
  const aadhaarDone = aadhaar?.status === "VERIFIED";

  return (
    <div className="space-y-4">
      {!(panDone && aadhaarDone) ? (
        <Card className="p-5">
          <label className="flex items-start gap-3 text-sm text-ink-700">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="kyc-consent"
            />
            <span>{RIDER_KYC_CONSENT_TEXT}</span>
          </label>
          {fields.consent ? <p className="mt-1 text-xs text-red-600">{fields.consent}</p> : null}
        </Card>
      ) : null}

      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-ink-900">PAN</h2>
          <StatusLine check={pan} />
        </div>
        {!panDone ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("pan", "/api/delivery-partner/me/kyc/pan", { pan: panInput, consent }, () => setPanInput(""));
            }}
          >
            <div className="min-w-48 flex-1">
              <Field label="PAN" hint="10 characters, e.g. ABCDE1234F" error={fields.pan}>
                <input
                  value={panInput}
                  onChange={(e) => setPanInput(e.target.value.toUpperCase())}
                  maxLength={10}
                  autoCapitalize="characters"
                  autoComplete="off"
                  className={inputClass}
                  data-testid="kyc-pan"
                />
              </Field>
            </div>
            <Button type="submit" disabled={busy !== null || !consent || panInput.trim().length !== 10}>
              {busy === "pan" ? "Verifying…" : "Verify PAN"}
            </Button>
          </form>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-ink-900">Aadhaar</h2>
          <StatusLine check={aadhaar} />
        </div>
        {!aadhaarDone ? (
          <>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("otp", "/api/delivery-partner/me/kyc/aadhaar/otp", { aadhaar: aadhaarInput, consent }, () => setAadhaarInput(""));
              }}
            >
              <div className="min-w-48 flex-1">
                <Field
                  label="Aadhaar number"
                  hint="We send an OTP to the mobile linked to your Aadhaar. GoKesari never stores the number."
                  error={fields.aadhaar}
                >
                  <input
                    value={aadhaarInput}
                    onChange={(e) => setAadhaarInput(e.target.value.replace(/[^\d ]/g, ""))}
                    inputMode="numeric"
                    maxLength={14}
                    autoComplete="off"
                    className={inputClass}
                    data-testid="kyc-aadhaar"
                  />
                </Field>
              </div>
              <Button type="submit" variant="secondary" disabled={busy !== null || !consent || aadhaarInput.replace(/\D/g, "").length !== 12}>
                {busy === "otp" ? "Sending OTP…" : aadhaar?.awaitingOtp ? "Send a new OTP" : "Send OTP"}
              </Button>
            </form>
            {aadhaar?.awaitingOtp ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("verify", "/api/delivery-partner/me/kyc/aadhaar/verify", { otp }, () => setOtp(""));
                }}
              >
                <div className="min-w-40">
                  <Field label="OTP" error={fields.otp}>
                    <input
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="one-time-code"
                      className={inputClass}
                      data-testid="kyc-otp"
                    />
                  </Field>
                </div>
                <Button type="submit" disabled={busy !== null || otp.length !== 6}>
                  {busy === "verify" ? "Checking…" : "Verify Aadhaar"}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {panDone && aadhaarDone ? (
        <Alert tone="success" title="KYC complete">
          Next, upload your police verification form and character certificate from{" "}
          <a className="font-medium underline" href="/delivery-partner/documents">
            Documents
          </a>
          .
        </Alert>
      ) : null}
    </div>
  );
}
