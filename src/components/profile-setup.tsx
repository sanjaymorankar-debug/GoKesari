"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddressForm } from "@/components/address-manager";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { INDIAN_MOBILE_HINT, parseIndianMobile } from "@/lib/contact";

export type GenderValue = "MALE" | "FEMALE" | "OTHER";

const GENDER_OPTIONS: { value: GenderValue | ""; label: string }[] = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "OTHER", label: "Other" },
  { value: "", label: "Prefer not to say" },
];

async function patchProfile(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const payload = await res.json().catch(() => null);
  return payload?.error?.message ?? "Could not save your details. Please try again.";
}

/** Shared name / gender / mobile fields, used by first-time setup and My Profile. */
export function PersonalDetailsFields({
  name,
  setName,
  gender,
  setGender,
  mobile,
  setMobile,
  mobileHint,
}: {
  name: string;
  setName: (v: string) => void;
  gender: GenderValue | "";
  setGender: (v: GenderValue | "") => void;
  mobile?: string;
  setMobile?: (v: string) => void;
  mobileHint?: string;
}) {
  return (
    <>
      <Field label="Full name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />
      </Field>
      <div>
        <span className="mb-1 block text-sm font-medium text-ink-700">Gender</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Gender">
          {GENDER_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={gender === opt.value}
              onClick={() => setGender(opt.value)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                gender === opt.value ? "border-kesari-600 bg-kesari-50 font-medium text-kesari-700" : "border-cream-200 text-ink-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {setMobile ? (
        <Field label="Mobile number" hint={mobileHint}>
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600">+91</span>
            <input
              className={inputClass}
              value={mobile ?? ""}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="10-digit mobile number"
              aria-label="Mobile number"
            />
          </div>
        </Field>
      ) : null}
    </>
  );
}

/**
 * First sign-in: personal details, then a delivery address with its geo-tag.
 * Every field is optional and "Fill in later" skips the rest; the details form
 * comes back on the next sign-in until it has been saved once.
 */
export function ProfileSetupWizard({
  initial,
  hasDefaultAddress,
  referral = null,
}: {
  initial: { name: string; gender: GenderValue | ""; mobile: string; email: string };
  hasDefaultAddress: boolean;
  /** Rule customerSignupReferral: ask a new customer for a referral code (prefilled from a /r/ link). */
  referral?: { prefill: string; required?: boolean } | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"details" | "address">("details");
  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState<GenderValue | "">(initial.gender);
  const [mobile, setMobile] = useState(initial.mobile);
  const [referralCode, setReferralCode] = useState(referral?.prefill ?? "");
  const [referralError, setReferralError] = useState<string | null>(null);
  // Mandatory code (customerSignupReferral.required): without one, setup ends on My referral code.
  const [referralGiven, setReferralGiven] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = () => {
    router.replace("/");
    router.refresh();
  };
  const finishSetup = () => {
    if (!referral?.required || referralGiven) return finish();
    router.replace("/referral");
    router.refresh();
  };

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (mobile && !parseIndianMobile(mobile).ok) return setError(INDIAN_MOBILE_HINT);
    setBusy(true);
    // The referral code is checked first, so a wrong one can be corrected here.
    if (referral && referralCode.trim()) {
      const res = await fetch("/api/me/signup-referral", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: referralCode }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setBusy(false);
        return setReferralError(payload?.error?.details?.fields?.referralCode ?? payload?.error?.message ?? "This referral code is not valid.");
      }
      setReferralGiven(true);
    }
    const failure = await patchProfile({
      name: name.trim() || null,
      gender: gender || null,
      ...(mobile ? { mobile } : {}),
      markComplete: true,
    });
    setBusy(false);
    if (failure) return setError(failure);
    if (hasDefaultAddress) finishSetup();
    else setStep("address");
  }

  return (
    <Card className="p-6 sm:p-8" data-testid="profile-setup">
      <p className="text-xs font-semibold uppercase tracking-wide text-kesari-700">
        Step {step === "details" ? 1 : 2} of {hasDefaultAddress ? 1 : 2}
      </p>
      {step === "details" ? (
        <form onSubmit={saveDetails} className="mt-2 grid gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink-900">Tell us about you</h1>
            <p className="mt-1 text-sm text-ink-500">
              Helps shops and delivery partners serve you. You can change these anytime in My Profile.
            </p>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label="Email">
            <input className={`${inputClass} bg-cream-50`} value={initial.email} readOnly aria-readonly />
          </Field>
          <PersonalDetailsFields
            name={name}
            setName={setName}
            gender={gender}
            setGender={setGender}
            mobile={mobile}
            setMobile={setMobile}
            mobileHint="Needed before your first order — the delivery partner calls this number. You can also log in with it."
          />
          {referral ? (
            <Field
              label={referral.required ? "Referral code" : "Referral code (optional)"}
              hint={
                referral.required
                  ? "Needed before your first order — from GoKesari, a GoKesari partner or a friend who invited you. No code? Leave it empty and ask us for one next."
                  : "From GoKesari, a GoKesari partner or a friend who invited you."
              }
              error={referralError ?? undefined}
            >
              <input
                className={inputClass}
                name="referralCode"
                value={referralCode}
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={40}
                onChange={(e) => {
                  setReferralCode(e.target.value.toUpperCase());
                  setReferralError(null);
                }}
                data-testid="signup-referral-code"
              />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save and continue"}
            </Button>
            <Button type="button" variant="secondary" onClick={finish} disabled={busy}>
              Fill in later
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 grid gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink-900">Delivery address</h1>
            <p className="mt-1 text-sm text-ink-500">
              Pin the exact spot on the map or use your current location so the delivery partner finds you. You will be
              asked for an address at checkout if you skip this.
            </p>
          </div>
          <AddressForm defaultIsDefault cancelLabel="Fill in later" onSaved={finishSetup} onCancel={finishSetup} />
        </div>
      )}
    </Card>
  );
}

/** After an email sign-in with no mobile on file. "Not now" brings it back on the next sign-in. */
export function MobilePromptDialog() {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    router.replace("/");
    router.refresh();
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!parseIndianMobile(mobile).ok) return setError(INDIAN_MOBILE_HINT);
    setBusy(true);
    const res = await fetch("/api/me/phone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobile }),
    });
    setBusy(false);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      return setError(payload?.error?.message ?? "Could not save the number. Please try again.");
    }
    close();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="mobile-prompt-title">
      <Card className="w-full max-w-sm p-6" data-testid="mobile-prompt">
        <h2 id="mobile-prompt-title" className="text-lg font-semibold text-ink-900">
          Add your mobile number
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          For faster login next time — and the delivery partner will need it when you order.
        </p>
        <form onSubmit={save} className="mt-4 grid gap-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600">+91</span>
            <input
              className={inputClass}
              value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="10-digit mobile number"
              aria-label="Mobile number"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={close} disabled={busy}>
              Not now
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
