"use client";

/**
 * Module 3: shop self-registration, mobile-first. Shop name, mobile and the
 * referral code → the code is checked first → an SMS code → choose the fee
 * plan → saved, and on to the payment page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

interface Tier {
  code: string;
  label: string;
  description: string | null;
  amountPaise: number;
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong. Please try again.");
  return data;
}

export function JoinForm({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"details" | "verify">("details");
  const [shopName, setShopName] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState(initialCode);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [distributor, setDistributor] = useState<string | null>(null);
  const [tier, setTier] = useState("");
  const [otp, setOtp] = useState("");
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const check = await post("/api/shop-registrations/referral-check", { code });
      if (!check.ok) throw new Error(check.message);
      setTiers(check.tiers);
      setDistributor(check.distributor);
      if (check.tiers.length === 1) setTier(check.tiers[0].code);
      if (check.tiers.length === 0) throw new Error("Registration fees are not set up yet. Please try again later.");
      await post("/api/shop-registrations/otp", { mobile, referralCode: code });
      setStep("verify");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await post("/api/shop-registrations", { shopName, mobile, referralCode: code, tierCode: tier, otp, acceptTerms: terms });
      router.push(`/shop/join/${created.token}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      {error ? <div className="mb-3"><Alert tone="danger">{error}</Alert></div> : null}
      {step === "details" ? (
        <form onSubmit={sendCode} className="space-y-3">
          <Field label="Shop name">
            <input className={inputClass} value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="e.g. Shree Ganesh Kirana" required minLength={2} maxLength={100} />
          </Field>
          <Field label="Mobile number" hint="We send a code by SMS. You sign in with this number later.">
            <input className={inputClass} value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="numeric" autoComplete="tel-national" placeholder="10-digit mobile" required />
          </Field>
          <Field label="Referral code" hint="From your GoKesari distributor.">
            <input className={`${inputClass} uppercase`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" required />
          </Field>
          <Button type="submit" disabled={busy || shopName.trim().length < 2 || mobile.trim().length < 10 || code.trim().length < 3} className="w-full">
            {busy ? "Checking…" : "Continue"}
          </Button>
        </form>
      ) : (
        <form onSubmit={register} className="space-y-3">
          <p className="text-sm text-ink-700">
            Code <b>{code}</b> is valid{distributor ? ` (${distributor})` : ""}. Enter the code we sent by SMS to +91 {mobile.replace(/\D/g, "").slice(-10)}.
          </p>
          <Field label="SMS code">
            <input className={inputClass} value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required />
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-ink-700">Choose your plan</legend>
            {tiers.map((t) => (
              <label key={t.code} className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${tier === t.code ? "border-kesari-500 bg-kesari-50" : "border-cream-200"}`}>
                <input type="radio" name="tier" value={t.code} checked={tier === t.code} onChange={() => setTier(t.code)} className="mt-1" />
                <span>
                  <span className="font-medium text-ink-900">{t.label}</span> — {rupees(t.amountPaise)}
                  {t.description ? <span className="block text-xs text-ink-500">{t.description}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-1" />
            <span>
              I accept the{" "}
              <a href="/legal/seller-terms" target="_blank" className="underline">Seller Terms</a>,{" "}
              <a href="/legal/terms" target="_blank" className="underline">Terms</a> and{" "}
              <a href="/legal/privacy-policy" target="_blank" className="underline">Privacy Policy</a>.
            </span>
          </label>
          <Button type="submit" disabled={busy || !tier || otp.trim().length < 4 || !terms} className="w-full">
            {busy ? "Saving…" : "Continue to payment"}
          </Button>
          <div className="flex justify-between text-xs">
            <button type="button" className="underline" onClick={() => setStep("details")}>Change details</button>
            <button type="button" className="underline" disabled={busy} onClick={() => void sendCode()}>Send the code again</button>
          </div>
        </form>
      )}
    </Card>
  );
}
