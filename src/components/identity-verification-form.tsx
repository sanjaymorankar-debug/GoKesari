"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  IDENTITY_CONSENT_TEXT,
  IDENTITY_METHOD_LABELS,
  IDENTITY_NOT_STORED_ITEMS,
  IDENTITY_PURPOSE_TEXT,
  IDENTITY_RETENTION_TEXT,
  IDENTITY_STATUS_LABELS,
  IDENTITY_STORED_ITEMS,
  IDENTITY_VOLUNTARY_TEXT,
} from "@/lib/kyc/identity";
import type { IdentityVerificationMethod, IdentityVerificationStatus } from "@/server/db/schema";

export interface IdentityCurrent {
  method: IdentityVerificationMethod;
  status: IdentityVerificationStatus;
  maskedId: string;
  verifiedName: string | null;
  reason: string | null;
  digilockerOpen: boolean;
}

/** The GoKesari app's page bridge (mobile/src/bridge-script.ts), when the page runs inside the app. */
interface AppBridge {
  scheme?: string;
  openDigiLocker?: (url: string) => Promise<unknown>;
}

function appBridge(): AppBridge | null {
  return typeof window === "undefined" ? null : ((window as unknown as { __gokesariApp?: AppBridge }).__gokesariApp ?? null);
}

const NEXT_KEY = "gk-verify-identity-next";
const RETURN_POLLS = 6;
const RETURN_POLL_MS = 5000;

const TONE: Record<IdentityVerificationStatus, "success" | "warning" | "danger"> = {
  VERIFIED: "success",
  PENDING: "warning",
  NAME_MISMATCH_REVIEW: "warning",
  REJECTED: "danger",
  FAILED: "danger",
};

async function post(url: string, body: unknown): Promise<{ ok: boolean; message: string | null; fields: Record<string, string>; data?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (response.ok) return { ok: true, message: null, fields: {}, data: payload ?? {} };
    return { ok: false, message: payload?.error?.message ?? "Something went wrong. Try again.", fields: payload?.error?.details?.fields ?? {} };
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again.", fields: {} };
  }
}

function storeNext(next: string | null) {
  try {
    if (next) sessionStorage.setItem(NEXT_KEY, next);
  } catch {
    /* private mode: the person goes back by hand */
  }
}

function takeNext(): string | null {
  try {
    const value = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
  } catch {
    return null;
  }
}

/**
 * docs/identity-verification-2026-11: consent screen (purpose, what is and is
 * not kept, retention, voluntary Aadhaar, unticked box), then Aadhaar by
 * DigiLocker or PAN. Shows the masked id only.
 */
export function IdentityVerificationForm({
  current,
  verified,
  panOffered,
  subject,
  seller,
  next,
}: {
  current: IdentityCurrent | null;
  verified: boolean;
  panOffered: boolean;
  subject: "CUSTOMER" | "SHOP_OWNER";
  seller: { required: boolean; graceEndsAt: string | null; graceOver: boolean };
  next: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returned = searchParams.get("digilocker");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<null | "digilocker" | "pan" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [panInput, setPanInput] = useState("");

  // Remember where to go back to across the DigiLocker round trip.
  useEffect(() => storeNext(next), [next]);
  useEffect(() => {
    if (!verified) return;
    const target = next ?? (returned ? takeNext() : null);
    if (target) router.replace(target);
  }, [verified, next, returned, router]);

  async function verifyWithDigilocker() {
    setBusy("digilocker");
    setError(null);
    setFields({});
    const bridge = appBridge();
    const inApp = typeof bridge?.openDigiLocker === "function";
    const result = await post("/api/account/identity/digilocker", { consent, app: inApp ? (bridge?.scheme ?? null) : null });
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
      await post("/api/account/identity/digilocker/sync", {});
      router.refresh();
      return;
    }
    window.location.assign(url);
  }

  async function verifyWithPan() {
    setBusy("pan");
    setError(null);
    setFields({});
    const result = await post("/api/account/identity/pan", { consent, pan: panInput });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      setFields(result.fields);
      return;
    }
    setPanInput("");
    router.refresh();
  }

  async function checkStatus() {
    setBusy("sync");
    await post("/api/account/identity/digilocker/sync", {});
    setBusy(null);
    router.refresh();
  }

  const polls = useRef(0);
  const waiting = current?.status === "PENDING" && Boolean(returned) && returned !== "verified";
  useEffect(() => {
    if (!waiting || polls.current >= RETURN_POLLS) return;
    const timer = setTimeout(async () => {
      polls.current += 1;
      await post("/api/account/identity/digilocker/sync", {});
      router.refresh();
    }, RETURN_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, current, router]);

  const inReview = current?.status === "NAME_MISMATCH_REVIEW";

  return (
    <div className="space-y-4" data-testid="identity-verification">
      {current ? (
        <Card className="space-y-1 p-5" data-testid="identity-status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[current.status]}>{IDENTITY_STATUS_LABELS[current.status]}</Badge>
            <span className="text-sm text-ink-700">{IDENTITY_METHOD_LABELS[current.method]}</span>
            <span className="font-mono text-sm text-ink-700">{current.maskedId}</span>
          </div>
          {current.verifiedName ? <p className="text-sm text-ink-700">Name on the document: {current.verifiedName}</p> : null}
          {current.reason ? <p className="text-xs text-ink-500">{current.reason}</p> : null}
        </Card>
      ) : null}

      {verified ? (
        <Alert tone="success" title="You are verified">
          You will not be asked again.{next ? " Taking you back…" : ""}
        </Alert>
      ) : (
        <>
          {subject === "SHOP_OWNER" && seller.required && seller.graceEndsAt ? (
            <Alert tone={seller.graceOver ? "danger" : "warning"} title={seller.graceOver ? "Your shop is not taking new orders" : "Verify to keep taking orders"}>
              {seller.graceOver
                ? "Your shop takes no new orders until you verify. Orders you already accepted are not affected."
                : `Please verify by ${new Date(seller.graceEndsAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}. After that your shop takes no new orders until you do.`}
            </Alert>
          ) : null}
          {inReview ? null : (
            <Card className="space-y-3 p-5" data-testid="identity-consent-screen">
              <h2 className="font-semibold text-ink-900">Before you start</h2>
              <p className="text-sm text-ink-700">{IDENTITY_PURPOSE_TEXT}</p>
              <div>
                <h3 className="text-sm font-semibold text-ink-900">What we keep</h3>
                <ul className="ml-5 list-disc text-sm text-ink-700">
                  {IDENTITY_STORED_ITEMS.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-ink-900">What we never keep</h3>
                <ul className="ml-5 list-disc text-sm text-ink-700">
                  {IDENTITY_NOT_STORED_ITEMS.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
              <p className="text-sm text-ink-700">
                <span className="font-semibold text-ink-900">How long: </span>
                {IDENTITY_RETENTION_TEXT}
              </p>
              <p className="text-sm text-ink-700">{panOffered ? IDENTITY_VOLUNTARY_TEXT : "Aadhaar is checked through DigiLocker by our licensed verification partner; GoKesari never sees or stores the number."}</p>
              <label className="flex items-start gap-3 text-sm text-ink-700">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="identity-consent" />
                <span>{IDENTITY_CONSENT_TEXT}</span>
              </label>
              {fields.consent ? <p className="text-xs text-red-600">{fields.consent}</p> : null}
            </Card>
          )}

          {inReview ? null : (
            <Card className="space-y-2 p-5">
              <h2 className="font-semibold text-ink-900">Aadhaar through DigiLocker</h2>
              <p className="text-sm text-ink-700">
                Sign in to DigiLocker with the OTP sent to your Aadhaar-linked mobile and allow GoKesari to see your Aadhaar. We keep only your name and the last four digits.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy !== null || !consent} onClick={() => void verifyWithDigilocker()} data-testid="identity-digilocker">
                  {busy === "digilocker" ? "Opening DigiLocker…" : current?.digilockerOpen ? "Continue in DigiLocker" : "Verify with DigiLocker"}
                </Button>
                {current?.status === "PENDING" && current.method === "AADHAAR_DIGILOCKER" ? (
                  <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void checkStatus()} data-testid="identity-digilocker-check">
                    {busy === "sync" ? "Checking…" : "Check status"}
                  </Button>
                ) : null}
              </div>
            </Card>
          )}

          {panOffered && !inReview ? (
            <Card className="space-y-2 p-5">
              <h2 className="font-semibold text-ink-900">Or use your PAN</h2>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void verifyWithPan();
                }}
              >
                <div className="min-w-48 flex-1">
                  <Field label="Your PAN" hint="Your own (personal) PAN, 10 characters, e.g. ABCPE1234F" error={fields.pan}>
                    <input
                      value={panInput}
                      onChange={(e) => setPanInput(e.target.value.toUpperCase())}
                      maxLength={10}
                      autoCapitalize="characters"
                      autoComplete="off"
                      className={inputClass}
                      data-testid="identity-pan"
                    />
                  </Field>
                </div>
                <Button type="submit" variant="secondary" disabled={busy !== null || !consent || panInput.trim().length !== 10} data-testid="identity-pan-submit">
                  {busy === "pan" ? "Verifying…" : "Verify PAN"}
                </Button>
              </form>
              <p className="text-xs text-ink-500">Driving licence and voter ID can&apos;t be checked online yet.</p>
            </Card>
          ) : null}
          {!consent && !inReview ? <p className="text-xs text-ink-500">Tick the consent box first.</p> : null}
        </>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
