"use client";

/**
 * My referral code (docs/four-features-2026-10, the owner's decision of
 * 9 Oct 2026). A new customer enters the referral code GoKesari (or a friend)
 * gave them — or, without one, asks for it: their location (when they allow
 * it), contact number, city and PIN code go to the referrals team, who call or
 * send someone and issue a code. An issued code appears here with "Use this
 * code".
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { checkCustomerReferralRequest, REFERRAL_REQUEST_STATUS_LABELS } from "@/lib/referral-requests";

export interface MyCustomerReferralRequest {
  id: string;
  reference: string;
  city: string;
  pincode: string;
  status: keyof typeof REFERRAL_REQUEST_STATUS_LABELS;
  issuedCode: string | null;
  decisionNote: string | null;
  createdAt: string;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, payload };
}

/** Enter a code: a code GoKesari issued, or a friend's (POST /api/me/signup-referral). */
export function EnterSignupReferralCode({ initialCode, required }: { initialCode: string; required: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return setError("Enter a referral code.");
    setBusy(true);
    setError(null);
    const { ok, payload } = await postJson("/api/me/signup-referral", { code });
    setBusy(false);
    if (!ok) return setError(payload?.error?.details?.fields?.referralCode ?? payload?.error?.message ?? "That code couldn't be used.");
    router.refresh();
  }

  return (
    <Card className="space-y-3 p-4" data-testid="enter-signup-referral">
      <h2 className="font-semibold text-ink-900">Enter your referral code</h2>
      <p className="text-sm text-ink-600">
        {required
          ? "GoKesari is open by invitation: a referral code is needed before your first order. You can browse and search shops and products without one."
          : "Joined with a code from GoKesari or a friend? Enter it before your first order."}
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={apply} noValidate>
        <div className="min-w-48 flex-1">
          <Field label="Referral code" error={error ?? undefined}>
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              data-testid="my-referral-code-input"
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Use this code"}
        </Button>
      </form>
    </Card>
  );
}

type LocationState =
  | { status: "idle" }
  | { status: "asking" }
  | { status: "shared"; latitude: number; longitude: number; accuracyM: number | null }
  | { status: "denied" }
  | { status: "unavailable" };

/** Ask GoKesari for a code: location (when allowed), contact number, city and PIN code. */
export function CustomerReferralRequestForm({ prefill }: { prefill: { name: string; mobile: string; city: string; pincode: string } }) {
  const router = useRouter();
  const [location, setLocation] = useState<LocationState>({ status: "idle" });
  const [values, setValues] = useState(prefill);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; mobileMasked: string; locationShared: boolean } | null>(null);

  function shareLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) return setLocation({ status: "unavailable" });
    setLocation({ status: "asking" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          status: "shared",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (failure) => setLocation({ status: failure.code === failure.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  // The location is asked for straight away (as for shop owners); the request never waits on it.
  useEffect(() => {
    queueMicrotask(shareLocation);
  }, []);

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: key === "mobile" || key === "pincode" ? e.target.value.replace(/\D/g, "").slice(0, key === "mobile" ? 10 : 6) : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const coords = location.status === "shared" ? { latitude: location.latitude, longitude: location.longitude, accuracyM: location.accuracyM } : {};
    const local = checkCustomerReferralRequest({ ...values, ...coords });
    if (!local.ok) return setFieldErrors(local.fields);
    setFieldErrors({});
    setBusy(true);
    const { ok, payload } = await postJson("/api/me/referral-request", { ...values, ...coords });
    setBusy(false);
    if (!ok) {
      setFieldErrors(payload?.error?.details?.fields ?? {});
      return setError(payload?.error?.message ?? "Could not send the request.");
    }
    setDone(payload);
    router.refresh();
  }

  if (done) {
    return (
      <div data-testid="customer-referral-request-done">
        <Alert tone="success" title="Request received">
          Thank you! Your request {done.reference} has reached our referrals team. We will call or message you on {done.mobileMasked} with your
          referral code; it will also appear on this page.
          {!done.locationShared ? " Your location was not shared, so we will use the city and PIN code you gave." : ""}
        </Alert>
      </div>
    );
  }

  const mapsUrl = location.status === "shared" ? `https://www.google.com/maps?q=${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}` : null;

  return (
    <Card className="space-y-3 p-4" data-testid="customer-referral-request">
      <h2 className="font-semibold text-ink-900">No referral code? Ask us for one</h2>
      <p className="text-sm text-ink-600">Tell us where you are and how to reach you. Our team will call, or send someone, and give you a referral code.</p>
      <div className="rounded-lg bg-cream-50 px-3 py-2 text-sm" data-testid="customer-referral-request-location">
        {location.status === "asking" ? (
          <span className="text-ink-600">Asking for your location… allow it so we can find you on Google Maps.</span>
        ) : location.status === "shared" ? (
          <span className="text-leaf-700">
            Location captured ({location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}).{" "}
            <a href={mapsUrl!} target="_blank" rel="noreferrer" className="underline">
              See on Google Maps
            </a>
          </span>
        ) : location.status === "idle" ? (
          <span className="text-ink-600">Your location helps us find you.</span>
        ) : (
          <span className="text-amber-800">
            Location not shared{location.status === "denied" ? " (permission denied)" : ""} — that is fine, your city and PIN code are enough.{" "}
            <button type="button" className="underline" onClick={shareLocation}>
              Try again
            </button>
          </span>
        )}
      </div>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} noValidate>
        <Field label="Your name" error={fieldErrors.name}>
          <input className={inputClass} value={values.name} onChange={set("name")} autoComplete="name" aria-label="Your name" />
        </Field>
        <Field label="Contact number" hint="10-digit mobile" error={fieldErrors.mobile}>
          <input className={inputClass} value={values.mobile} onChange={set("mobile")} inputMode="numeric" autoComplete="tel-national" aria-label="Contact number" />
        </Field>
        <Field label="City" error={fieldErrors.city}>
          <input className={inputClass} value={values.city} onChange={set("city")} autoComplete="address-level2" aria-label="City" />
        </Field>
        <Field label="PIN code" hint="6 digits" error={fieldErrors.pincode}>
          <input className={inputClass} value={values.pincode} onChange={set("pincode")} inputMode="numeric" autoComplete="postal-code" aria-label="PIN code" />
        </Field>
        {fieldErrors.location ? <p className="text-xs text-red-600 sm:col-span-2">{fieldErrors.location}</p> : null}
        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
        <div className="sm:col-span-2">
          {/* Never blocked on the location prompt: still waiting means it is sent without one. */}
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Request a referral code"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The customer's requests — with the issued code and a button to use it. */
export function MyCustomerReferralRequests({ requests, canUse }: { requests: MyCustomerReferralRequest[]; canUse: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function use(code: string) {
    setBusy(code);
    setError(null);
    const { ok, payload } = await postJson("/api/me/signup-referral", { code });
    setBusy(null);
    if (!ok) return setError(payload?.error?.details?.fields?.referralCode ?? payload?.error?.message ?? "That code couldn't be used.");
    router.refresh();
  }

  if (requests.length === 0) return null;
  return (
    <Card className="space-y-2 p-4" data-testid="my-customer-referral-requests">
      <h2 className="font-semibold text-ink-900">Your requests</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ul className="divide-y divide-cream-200 text-sm">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <p className="font-medium text-ink-900">
                {r.reference} · {r.city} {r.pincode}
              </p>
              <p className="text-xs text-ink-500">
                {new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {REFERRAL_REQUEST_STATUS_LABELS[r.status]}
                {r.status === "REJECTED" && r.decisionNote ? ` — ${r.decisionNote}` : ""}
              </p>
            </div>
            {r.issuedCode ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md border border-dashed border-kesari-400 bg-kesari-50 px-2 py-1 font-mono font-semibold text-kesari-800" data-testid="issued-customer-code">
                  {r.issuedCode}
                </span>
                {canUse ? (
                  <Button size="sm" onClick={() => void use(r.issuedCode!)} disabled={busy !== null}>
                    {busy === r.issuedCode ? "Checking…" : "Use this code"}
                  </Button>
                ) : null}
              </div>
            ) : r.status === "NEW" ? (
              <span className="text-xs text-ink-500">We will contact you soon.</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
