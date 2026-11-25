"use client";

/**
 * docs/guest-checkout-2026-11: the guest step at the cart (flags guest_cart_enabled +
 * guest_checkout_enabled). Contact + address, then the one-time code(s), then a normal session and
 * the usual payment choice on /cart — no password, no registration form.
 *
 *  1. POST /api/guest-checkout/start → a code to the e-mail (and by SMS where set up).
 *  2. verifyGuestCheckoutAction → account found or created, address saved, signed in, back to
 *     /cart; GuestCartMerge then moves this browser's cart into the account cart.
 */
import Link from "next/link";
import { useState, useTransition } from "react";

import { verifyGuestCheckoutAction } from "@/app/cart/guest-checkout-actions";
import { SignInConsentCheckbox, SignInConsentProvider, useSignInConsent } from "@/components/signin-consent";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { GC } from "@/lib/guest-checkout-i18n";
import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S } from "@/lib/return-to";

export interface GuestCheckoutPrefill {
  pincode: string | null;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
}

type Fields = Record<string, string>;

export function GuestCheckoutForm(props: { lang: Lang; prefill: GuestCheckoutPrefill | null; disabled?: boolean }) {
  return (
    <SignInConsentProvider>
      <Inner {...props} />
    </SignInConsentProvider>
  );
}

function Inner({ lang, prefill, disabled }: { lang: Lang; prefill: GuestCheckoutPrefill | null; disabled?: boolean }) {
  const agreed = useSignInConsent();
  const [form, setForm] = useState({
    name: "",
    mobile: "",
    email: "",
    line1: "",
    area: prefill?.area ?? "",
    city: "",
    pincode: prefill?.pincode ?? "",
  });
  const [sent, setSent] = useState<{ maskedEmail: string; mobileCodeSent: boolean } | null>(null);
  const [codes, setCodes] = useState({ emailCode: "", mobileCode: "" });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({});
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const payload = () => ({
    name: form.name,
    mobile: form.mobile,
    email: form.email,
    address: {
      line1: form.line1,
      area: form.area || null,
      city: form.city,
      pincode: form.pincode,
      latitude: prefill?.latitude ?? null,
      longitude: prefill?.longitude ?? null,
    },
  });

  async function sendCodes() {
    setError(null);
    setFields({});
    setBusy(true);
    try {
      const response = await fetch("/api/guest-checkout/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not send the code. Try again.");
        setFields(body?.error?.details?.fields ?? {});
        return;
      }
      setSent({ maskedEmail: body.maskedEmail, mobileCodeSent: Boolean(body.mobileCodeSent) });
    } catch {
      setError("Could not send the code. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  function verify() {
    setError(null);
    setFields({});
    // After sign-in, /cart is the page to come back to even if the redirect is lost (D-23 cookie).
    try {
      const secure = window.location.protocol === "https:" ? "; secure" : "";
      document.cookie = `${RETURN_TO_COOKIE}=${encodeURIComponent("/cart")}; max-age=${RETURN_TO_MAX_AGE_S}; path=/; samesite=lax${secure}`;
    } catch {
      // Not needed for the redirect below; only a fallback.
    }
    startTransition(async () => {
      const result = await verifyGuestCheckoutAction({
        ...payload(),
        emailCode: codes.emailCode,
        mobileCode: sent?.mobileCodeSent ? codes.mobileCode : null,
        acceptedTerms: agreed,
      });
      if (result?.error) {
        setError(result.error);
        setFields(result.fields ?? {});
      }
    });
  }

  return (
    <Card className="p-4" data-testid="guest-checkout">
      <h2 className="text-base font-bold text-ink-900">{tr(GC.title, lang)}</h2>
      <p className="mt-1 text-sm text-ink-600">{tr(GC.intro, lang)}</p>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <fieldset disabled={Boolean(sent) || busy} className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={tr(GC.name, lang)} error={fields.name}>
          <input className={inputClass} autoComplete="name" value={form.name} onChange={set("name")} data-testid="guest-name" />
        </Field>
        <Field label={tr(GC.mobile, lang)} error={fields.mobile}>
          <input className={inputClass} inputMode="tel" autoComplete="tel-national" value={form.mobile} onChange={set("mobile")} data-testid="guest-mobile" />
        </Field>
        <div className="sm:col-span-2">
          <Field label={tr(GC.email, lang)} error={fields.email}>
            <input className={inputClass} type="email" autoComplete="email" value={form.email} onChange={set("email")} data-testid="guest-email" />
          </Field>
        </div>
        <p className="text-sm font-semibold text-ink-800 sm:col-span-2">{tr(GC.address, lang)}</p>
        <div className="sm:col-span-2">
          <Field label={tr(GC.line1, lang)} error={fields["address.line1"] ?? fields.line1}>
            <input className={inputClass} autoComplete="address-line1" value={form.line1} onChange={set("line1")} data-testid="guest-line1" />
          </Field>
        </div>
        <Field label={tr(GC.area, lang)}>
          <input className={inputClass} value={form.area} onChange={set("area")} />
        </Field>
        <Field label={tr(GC.city, lang)} error={fields["address.city"] ?? fields.city}>
          <input className={inputClass} autoComplete="address-level2" value={form.city} onChange={set("city")} data-testid="guest-city" />
        </Field>
        <Field label={tr(GC.pincode, lang)} error={fields["address.pincode"] ?? fields.pincode} hint={prefill?.pincode ? "From the location you chose" : undefined}>
          <input className={inputClass} inputMode="numeric" maxLength={6} value={form.pincode} onChange={set("pincode")} data-testid="guest-pincode" />
        </Field>
      </fieldset>

      {!sent ? (
        <>
          <SignInConsentCheckbox className="mt-3" />
          <Button className="mt-2 h-12 w-full text-base font-bold" onClick={sendCodes} disabled={disabled || busy || !agreed} data-testid="guest-send-code">
            {busy ? "Sending…" : tr(GC.sendCode, lang)}
          </Button>
        </>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink-700">
            {tr(GC.codeSent, lang)} <strong>{sent.maskedEmail}</strong>
            {sent.mobileCodeSent ? " + SMS" : ""}.
          </p>
          <Field label={tr(GC.emailCode, lang)} error={fields.emailCode}>
            <input
              className={inputClass}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={codes.emailCode}
              onChange={(e) => setCodes((c) => ({ ...c, emailCode: e.target.value }))}
              data-testid="guest-email-code"
            />
          </Field>
          {sent.mobileCodeSent ? (
            <Field label={tr(GC.mobileCode, lang)} error={fields.mobileCode}>
              <input
                className={inputClass}
                inputMode="numeric"
                value={codes.mobileCode}
                onChange={(e) => setCodes((c) => ({ ...c, mobileCode: e.target.value }))}
                data-testid="guest-mobile-code"
              />
            </Field>
          ) : null}
          <Button className="h-12 w-full text-base font-bold" onClick={verify} disabled={pending || !codes.emailCode.trim()} data-testid="guest-verify">
            {pending ? "Checking…" : tr(GC.verify, lang)}
          </Button>
          <button type="button" className="text-sm text-kesari-700 hover:underline" onClick={() => setSent(null)}>
            Change details / send a new code
          </button>
        </div>
      )}
      <p className="mt-3 text-center text-xs text-ink-600">
        <Link href="/signin" className="hover:underline">
          {tr(GC.orSignIn, lang)}
        </Link>
      </p>
    </Card>
  );
}
