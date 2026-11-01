"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { RIDER_KYC_CONSENT_TEXT, RIDER_KYC_STATUS_LABELS, type RiderKycStatus } from "@/lib/gig/kyc";

export interface KycCheckProps {
  status: RiderKycStatus;
  numberMasked: string;
  reason: string | null;
  awaitingOtp: boolean;
  /** Aadhaar by DigiLocker: a link is open and can still be used. */
  digilockerOpen?: boolean;
}

/** The GoKesari app's page bridge (mobile/src/bridge-script.ts), when the page runs inside the app. */
interface AppBridge {
  scheme?: string;
  openDigiLocker?: (url: string) => Promise<unknown>;
}

function appBridge(): AppBridge | null {
  return typeof window === "undefined" ? null : ((window as unknown as { __gokesariApp?: AppBridge }).__gokesariApp ?? null);
}

/** How many times the page re-asks after DigiLocker sent the partner back while the result is not in yet. */
const RETURN_POLLS = 6;
const RETURN_POLL_MS = 5000;

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

async function post(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; message: string | null; fields: Record<string, string>; data?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (response.ok) return { ok: true, message: null, fields: {}, data: payload ?? {} };
    return { ok: false, message: payload?.error?.message ?? "Something went wrong. Try again.", fields: payload?.error?.details?.fields ?? {} };
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again.", fields: {} };
  }
}

/**
 * Gig worker flow (feature 2): consent, then PAN and Aadhaar. Aadhaar is shared
 * from DigiLocker (aadhaarMethod "digilocker": the partner signs in there with
 * an Aadhaar OTP and consents; DigiLocker sends them back here), or — legacy —
 * checked by OTP to the Aadhaar-linked mobile. Shows Verified / Pending /
 * Failed with the masked number only; full numbers never come back.
 */
export function RiderKycForm({
  pan,
  aadhaar,
  aadhaarMethod = "digilocker",
}: {
  pan: KycCheckProps | null;
  aadhaar: KycCheckProps | null;
  aadhaarMethod?: "digilocker" | "okyc_legacy";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returned = searchParams.get("digilocker");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<null | "pan" | "otp" | "verify" | "digilocker" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [panInput, setPanInput] = useState("");
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [otp, setOtp] = useState("");

  async function run(kind: "pan" | "otp" | "verify" | "sync", url: string, body: unknown, after?: () => void) {
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

  async function verifyWithDigilocker() {
    setBusy("digilocker");
    setError(null);
    setFields({});
    const bridge = appBridge();
    const inApp = typeof bridge?.openDigiLocker === "function";
    const result = await post("/api/delivery-partner/me/kyc/aadhaar/digilocker", { consent, app: inApp ? (bridge?.scheme ?? null) : null });
    const url = typeof result.data?.url === "string" ? result.data.url : null;
    if (!result.ok || !url) {
      setBusy(null);
      if (!result.ok) {
        setError(result.message);
        setFields(result.fields);
      }
      router.refresh();
      return;
    }
    if (inApp) {
      // The app opens DigiLocker in its in-app browser and comes back here when it closes.
      await bridge!.openDigiLocker!(url).catch(() => null);
      setBusy(null);
      await post("/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {});
      router.refresh();
      return;
    }
    window.location.assign(url);
  }

  // Back from DigiLocker before the result is in: ask again a few times.
  const polls = useRef(0);
  const waiting = aadhaarMethod === "digilocker" && aadhaar?.status === "PENDING" && Boolean(returned) && returned !== "verified";
  useEffect(() => {
    if (!waiting || polls.current >= RETURN_POLLS) return;
    const timer = setTimeout(async () => {
      polls.current += 1;
      await post("/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {});
      router.refresh();
    }, RETURN_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, aadhaar, router]);

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
        {!aadhaarDone && aadhaarMethod === "digilocker" ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-700">
              Share your Aadhaar from DigiLocker: sign in there with the OTP sent to your Aadhaar-linked mobile, then allow GoKesari to see
              your Aadhaar. GoKesari keeps only your name and the last four digits.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy !== null || !consent} onClick={() => void verifyWithDigilocker()} data-testid="kyc-digilocker">
                {busy === "digilocker" ? "Opening DigiLocker…" : aadhaar?.digilockerOpen ? "Continue in DigiLocker" : "Verify with DigiLocker"}
              </Button>
              {aadhaar?.status === "PENDING" ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void run("sync", "/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {})}
                  data-testid="kyc-digilocker-check"
                >
                  {busy === "sync" ? "Checking…" : "Check status"}
                </Button>
              ) : null}
            </div>
            {!consent ? <p className="text-xs text-ink-500">Tick the consent box above first.</p> : null}
          </div>
        ) : null}
        {!aadhaarDone && aadhaarMethod === "okyc_legacy" ? (
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
