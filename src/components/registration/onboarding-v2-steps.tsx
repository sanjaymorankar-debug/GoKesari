"use client";

/**
 * Onboarding v2, Flow 2 — the shop registration screens that v2 adds (docs/onboarding-v2-2026-11): identity,
 * the fee paid on the draft, the licences' four options and the seller agreement. The rest of the wizard
 * (referral, GST / PAN, owner name, shop type, address, map pin, live) is the existing one
 * (onboarding-wizard.tsx). Every answer from the server is the whole wizard. Works the same in the Android and
 * iPhone apps (the web view): file inputs offer files, photos and the camera; Scan opens the camera directly.
 * Times are shown in IST.
 */
import { useState, type ReactNode } from "react";

import { AgreementsSigner } from "@/components/agreements/agreements-signer";
import { SellerUndertakingClauses } from "@/components/legal/seller-undertaking-clauses";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { SELLER_TERMS_ACCEPT_TEXT, SELLER_UNDERTAKING_PROMISE, SELLER_UNDERTAKING_TITLE } from "@/lib/legal/seller-undertaking";
import { SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";
import { extractLicenceFields } from "@/lib/onboarding-v2/licence-ocr";

/** ₹1,180 / ₹1,180.50 from paise. */
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/** One annual turnover band and its registration fee (shop-view.ts V2FeeSlab). */
interface FeeSlab {
  slab: number;
  label: string;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
}
export interface V2LicenceState {
  key: string;
  label: string;
  level: "MUST_HAVE" | "PROMISE";
  checkable: boolean;
  laterAllowed: boolean;
  entry: {
    option: "ENTER" | "UPLOAD" | "SCAN" | "LATER";
    status: "VERIFIED" | "PENDING_OPERATOR" | "PROMISED" | "REJECTED";
    statusReason: string | null;
    numberMasked: string | null;
    holderName: string | null;
    validUntil: string | null;
    issuingAuthority: string | null;
    hasFile: boolean;
    promisedAt: string | null;
  } | null;
  done: boolean;
}
export interface V2State {
  identity: {
    termsAccepted: boolean;
    termsVersion: string;
    email: string | null;
    emailVerified: boolean;
    emailMissing: boolean;
    mobile: string | null;
    mobileVerified: boolean;
    mobileSavedUnverified: boolean;
    smsAvailable: boolean;
    fallbackWhenNoSms: boolean;
    skipped: boolean;
    done: boolean;
  };
  names: { shopName: string | null; ownerName: string | null };
  fee: {
    byTurnover: boolean;
    slabs: FeeSlab[];
    flat: { basePaise: number; gstPaise: number; totalPaise: number } | null;
    chosenSlab: number | null;
    couponCode: string | null;
    legacyWholesale: boolean;
    paid: boolean;
    paidAtIst: string | null;
    paidPaise: number | null;
    pending: boolean;
    lastFailed: boolean;
  };
  licences: V2LicenceState[];
  promiseDays: number;
  promiseDueLabel: string;
  sla: { accepted: boolean; acceptedAtIst: string | null; agreementsEnabled: boolean; agreementsRequired: boolean };
  returnTo: string | null;
}

/** What the v2 screens need of the wizard's state. */
export interface V2WizardLike {
  v2?: V2State | null;
  nextStep: string;
  shopType?: string | null;
  address: { addressLine1: string; city: string; pincode: string } | null;
  shop: { id: string; name: string; status: string } | null;
}

type Send = (path: string, body?: unknown) => Promise<boolean>;
const API = "/api/shops/registration-draft/v2";

function V2Card({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Card className="rounded-2xl border-[var(--gk-line)] p-3 sm:p-5">
      <h2 className="text-base font-semibold text-ink-900 sm:text-lg">{title}</h2>
      {intro ? <p className="mt-0.5 text-sm text-ink-500">{intro}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </Card>
  );
}

/** Posts JSON or a form to a v2 route and returns the parsed answer (or the error message). */
async function call(path: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; fields?: Record<string, string> }> {
  const init: RequestInit =
    body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init).catch(() => null);
  if (!response) return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  const payload = await response.json().catch(() => null);
  if (response.ok && payload) return { ok: true, data: payload as Record<string, unknown> };
  return { ok: false, error: payload?.error?.message ?? "Something went wrong. Please try again.", fields: payload?.error?.details?.fields };
}

/* ---------------------------------------------------------- 1. identity */

export function V2IdentityStep({ v2, busy, fields, send }: { v2: V2State; busy: boolean; fields: Record<string, string>; send: Send }) {
  const id = v2.identity;
  const [terms, setTerms] = useState(id.termsAccepted);
  const [email, setEmail] = useState(id.email ?? "");
  const [emailCode, setEmailCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [mobile, setMobile] = useState(id.mobile ?? "");
  const [mobileCode, setMobileCode] = useState("");
  const [mobileSent, setMobileSent] = useState(false);
  return (
    <V2Card title="Verify it's you" intro="Accept the Terms, confirm your e-mail and your mobile number. You do this once — it also completes your GoKesari customer account.">
      <div className="rounded-lg border border-[var(--gk-line)] bg-white p-3" data-testid="v2-terms">
        <label className="flex items-start gap-3 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={terms} disabled={id.termsAccepted} onChange={(e) => setTerms(e.target.checked)} />
          <span>
            I accept GoKesari&apos;s <a href="/legal/terms" target="_blank" rel="noopener" className="text-kesari-700 underline">Terms &amp; Conditions</a> and{" "}
            <a href="/legal/privacy-policy" target="_blank" rel="noopener" className="text-kesari-700 underline">Privacy Policy</a> (version {id.termsVersion}).
          </span>
        </label>
        {!id.termsAccepted ? (
          <Button className="mt-2" disabled={busy || !terms} onClick={() => void send(`${API}/identity`, { action: "terms", accept: true })} data-testid="v2-terms-accept">
            Accept
          </Button>
        ) : (
          <p className="mt-1 text-xs text-leaf-700">✓ Accepted</p>
        )}
      </div>

      <div className="rounded-lg border border-[var(--gk-line)] bg-white p-3" data-testid="v2-email">
        <p className="text-sm font-semibold text-ink-900">E-mail {id.emailVerified ? <Badge tone="success">Verified</Badge> : null}</p>
        {id.emailVerified ? (
          <p className="text-sm text-ink-700">{id.email}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-500">Signing in with Google also confirms your e-mail. Otherwise we send you a code.</p>
            {id.emailMissing || !id.email ? (
              <Field label="Your e-mail address" error={fields.email}>
                <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            ) : (
              <p className="text-sm text-ink-700">{id.email}</p>
            )}
            <Button
              variant="secondary"
              disabled={busy || !id.termsAccepted}
              onClick={() => void send(`${API}/identity`, { action: "email-code", email: id.emailMissing ? email : null }).then((okd) => okd && setEmailSent(true))}
              data-testid="v2-email-send"
            >
              {emailSent ? "Send the code again" : "Send me a code"}
            </Button>
            {emailSent ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Code from the e-mail" error={fields.code}>
                  <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={emailCode} onChange={(e) => setEmailCode(e.target.value.trim())} />
                </Field>
                <Button disabled={busy || emailCode.length < 4} onClick={() => void send(`${API}/identity`, { action: "email-verify", email: id.emailMissing ? email : null, code: emailCode })} data-testid="v2-email-verify">
                  Confirm
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[var(--gk-line)] bg-white p-3" data-testid="v2-mobile">
        <p className="text-sm font-semibold text-ink-900">
          Mobile number {id.mobileVerified ? <Badge tone="success">Verified</Badge> : id.mobileSavedUnverified ? <Badge tone="warning">Saved</Badge> : null}
        </p>
        {id.mobileVerified || id.mobileSavedUnverified ? (
          <p className="text-sm text-ink-700">+91 {id.mobile}</p>
        ) : (
          <div className="space-y-2">
            <Field label="10-digit mobile number" error={fields.mobile}>
              <input className={inputClass} inputMode="tel" autoComplete="tel-national" value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </Field>
            {!id.smsAvailable && id.fallbackWhenNoSms ? (
              <p className="text-xs text-ink-500">SMS codes are not available right now, so your number is saved and confirmed later.</p>
            ) : null}
            <Button
              variant="secondary"
              disabled={busy || !id.emailVerified || mobile.replace(/\D/g, "").length < 10}
              onClick={() => void send(`${API}/identity`, { action: "mobile-code", mobile }).then((okd) => okd && setMobileSent(id.smsAvailable))}
              data-testid="v2-mobile-send"
            >
              {id.smsAvailable ? (mobileSent ? "Send the code again" : "Send me a code by SMS") : "Save my number"}
            </Button>
            {mobileSent ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Code from the SMS" error={fields.code}>
                  <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={mobileCode} onChange={(e) => setMobileCode(e.target.value.trim())} />
                </Field>
                <Button disabled={busy || mobileCode.length < 4} onClick={() => void send(`${API}/identity`, { action: "mobile-verify", mobile, code: mobileCode })} data-testid="v2-mobile-verify">
                  Confirm
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </V2Card>
  );
}

/* ----------------------------------------------------------------- 4. fee */

export function FeeStep({ v2, ownerName, onError }: { v2: V2State; ownerName: string | null; onError: (message: string, fields?: Record<string, string>) => void }) {
  // Owner, 27-Nov-2026: the original fee — the annual turnover band (the same bands and fees as the original
  // registration), + GST; the flat fee when fees by turnover are off. Wholesale stores pay the same.
  const [slab, setSlab] = useState<number | null>(v2.fee.chosenSlab);
  const [coupon, setCoupon] = useState(v2.fee.couponCode ?? "");
  const [shopName, setShopName] = useState(v2.names.shopName ?? "");
  const [owner, setOwner] = useState(ownerName ?? "");
  const [busy, setBusy] = useState(false);
  const chosen = v2.fee.byTurnover ? v2.fee.slabs.find((s) => s.slab === slab) ?? null : v2.fee.flat;
  async function pay() {
    setBusy(true);
    const result = await call(`${API}/fee`, { slab: v2.fee.byTurnover ? slab : null, couponCode: coupon.trim() || null, shopName, ownerName: owner || null });
    if (!result.ok) {
      setBusy(false);
      onError(result.error, result.fields);
      return;
    }
    const url = result.data.redirectUrl;
    if (typeof url === "string" && url) window.location.assign(url);
    else window.location.reload();
  }
  return (
    <V2Card title="Pay the registration fee" intro="Your business is verified. Confirm your shop's name, choose your annual turnover and pay online (UPI, card or net banking).">
      {v2.fee.lastFailed ? (
        <Alert tone="danger" title="Your last payment did not go through">
          No money was taken for it. You can try again below.
        </Alert>
      ) : null}
      {v2.fee.pending ? <Alert tone="info">A payment is open. If you already paid, it shows here in a minute — or pay again below; you are charged once.</Alert> : null}
      <Field label="Shop name (from your GST / PAN record)">
        <input className={inputClass} value={shopName} onChange={(e) => setShopName(e.target.value)} data-testid="v2-shop-name" />
      </Field>
      <Field label="Owner's name">
        <input className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      {v2.fee.byTurnover ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-700">Annual turnover — sets your yearly registration fee</legend>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" data-testid="v2-turnover-slabs">
            {v2.fee.slabs.map((s) => (
              <button
                key={s.slab}
                type="button"
                role="radio"
                aria-checked={slab === s.slab}
                onClick={() => setSlab(s.slab)}
                className={`min-h-14 rounded-xl border px-3 py-1.5 text-left ${slab === s.slab ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`}
                data-testid={`v2-fee-slab-${s.slab}`}
              >
                <span className="block text-sm font-semibold text-ink-900">{s.label}</span>
                <span className="block text-xs text-ink-700">
                  Fee {rupees(s.basePaise)}
                  {s.gstPaise > 0 ? ` + GST ${rupees(s.gstPaise)} = ${rupees(s.totalPaise)}` : ""}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">Wholesale stores pay the same fee and choose &quot;Wholesale store&quot; as the shop type next.</p>
        </fieldset>
      ) : v2.fee.flat ? (
        <p className="text-sm font-semibold text-ink-900" data-testid="v2-fee-flat">
          Registration fee {rupees(v2.fee.flat.basePaise)}
          {v2.fee.flat.gstPaise > 0 ? ` + GST ${rupees(v2.fee.flat.gstPaise)} = ${rupees(v2.fee.flat.totalPaise)}` : ""}
        </p>
      ) : null}
      <details className="text-sm text-ink-700">
        <summary className="cursor-pointer font-medium">Coupon code (optional)</summary>
        <Field label="Coupon code (optional)">
          <input className={`${inputClass} uppercase`} value={coupon} onChange={(e) => setCoupon(e.target.value)} maxLength={40} data-testid="v2-fee-coupon" />
        </Field>
      </details>
      <Button className="w-full" disabled={busy || shopName.trim().length < 2 || !chosen} onClick={() => void pay()} data-testid="v2-fee-pay">
        {chosen ? (coupon.trim() ? "Apply the coupon and pay" : `Pay ${rupees(chosen.totalPaise)}`) : "Choose your annual turnover"}
      </Button>
      <Alert tone="warning" title="Pending until the fee is paid">
        Your registration waits here until the payment clears. You can still shop on GoKesari as a customer and come back to finish.
      </Alert>
    </V2Card>
  );
}

/* ------------------------------------------------------------ 6. licences */

const STATUS_TEXT: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING_OPERATOR: { label: "With GoKesari's team", tone: "warning" },
  PROMISED: { label: "Upload later", tone: "neutral" },
  REJECTED: { label: "Please send again", tone: "danger" },
};

function LicenceCard({ licence, v2, onState }: { licence: V2LicenceState; v2: V2State; onState: (next: unknown) => void }) {
  const [option, setOption] = useState<"ENTER" | "UPLOAD" | "SCAN" | "LATER">(licence.entry?.option ?? "ENTER");
  const [open, setOpen] = useState(!licence.done);
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [authority, setAuthority] = useState("");
  const [consent, setConsent] = useState(false);
  const [promise, setPromise] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [ocr, setOcr] = useState<Record<string, string | null> | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  /** Reads the photo on the device (no upload), then pre-fills the fields for the owner to confirm. */
  async function readPhoto(f: File) {
    setFile(f);
    if (!f.type.startsWith("image/")) return;
    setReading(true);
    try {
      const { readInBrowser } = await import("@/lib/kyc/browser-ocr");
      const read = await readInBrowser(f);
      if (read?.text) {
        const got = extractLicenceFields(read.text, licence.key);
        setOcr({ number: got.number, holderName: got.holderName, validUntil: got.validUntil, issuingAuthority: got.issuingAuthority });
        if (got.number) setNumber(got.number);
        if (got.holderName) setHolderName(got.holderName);
        if (got.validUntil) setValidUntil(got.validUntil);
        if (got.issuingAuthority) setAuthority(got.issuingAuthority);
      }
    } finally {
      setReading(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setFields({});
    let body: unknown;
    if ((option === "UPLOAD" || option === "SCAN") && file) {
      const form = new FormData();
      form.set("licenceKey", licence.key);
      form.set("option", option);
      form.set("file", file);
      form.set("source", option === "SCAN" ? "CAMERA" : "FILE");
      if (number) form.set("number", number);
      if (holderName) form.set("holderName", holderName);
      if (validUntil) form.set("validUntil", validUntil);
      if (authority) form.set("issuingAuthority", authority);
      form.set("consent", String(consent));
      if (ocr) form.set("ocr", JSON.stringify(ocr));
      body = form;
    } else if (option === "LATER") {
      body = { licenceKey: licence.key, option, promise };
    } else {
      body = { licenceKey: licence.key, option, number, holderName: holderName || null, validUntil: validUntil || null, issuingAuthority: authority || null, consent };
    }
    const result = await call(`${API}/licences`, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setFields(result.fields ?? {});
      return;
    }
    setOpen(false);
    onState(result.data);
  }

  const status = licence.entry ? STATUS_TEXT[licence.entry.status] : null;
  const numberFields = (
    <>
      <Field label="Licence / registration number" error={fields.number}>
        <input className={inputClass} value={number} onChange={(e) => setNumber(e.target.value)} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Name on it (optional)">
          <input className={inputClass} value={holderName} onChange={(e) => setHolderName(e.target.value)} />
        </Field>
        <Field label="Valid until (optional)">
          <input className={inputClass} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </Field>
        <Field label="Issued by (optional)">
          <input className={inputClass} value={authority} onChange={(e) => setAuthority(e.target.value)} />
        </Field>
      </div>
      {licence.checkable ? (
        <label className="flex items-start gap-3 text-xs text-ink-700">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{SELLER_VERIFICATION_CONSENT_TEXT}</span>
        </label>
      ) : null}
    </>
  );
  const options: { key: typeof option; label: string }[] = [
    { key: "ENTER", label: "Enter details" },
    { key: "UPLOAD", label: "Upload file" },
    { key: "SCAN", label: "Scan" },
    ...(licence.laterAllowed ? [{ key: "LATER" as const, label: "Upload later" }] : []),
  ];
  const canSave =
    option === "LATER" ? promise : option === "UPLOAD" ? Boolean(file) : option === "SCAN" ? number.trim().length >= 3 : number.trim().length >= 3;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--gk-line)] bg-white p-3" data-testid={`v2-licence-${licence.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">
          {licence.label} {licence.level === "MUST_HAVE" ? <Badge tone="danger">Required by law</Badge> : null}
        </p>
        {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </div>
      {licence.entry ? (
        <p className="text-xs text-ink-600">
          {licence.entry.numberMasked ? `${licence.entry.numberMasked} · ` : ""}
          {licence.entry.statusReason ?? (licence.entry.promisedAt ? `Promised on ${licence.entry.promisedAt}` : "")}
        </p>
      ) : null}
      {!open ? (
        <button type="button" className="min-h-11 text-sm font-semibold text-kesari-700 underline" onClick={() => setOpen(true)}>
          Change
        </button>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`How to give your ${licence.label}`}>
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={option === o.key}
                onClick={() => setOption(o.key)}
                className={`min-h-11 rounded-full border px-3 text-sm ${option === o.key ? "border-kesari-600 bg-kesari-600 text-white" : "border-[var(--gk-line)] bg-white text-ink-700"}`}
                data-testid={`v2-licence-${licence.key}-${o.key.toLowerCase()}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {!licence.laterAllowed ? <p className="text-xs text-ink-500">This licence is required before your shop goes live, so it cannot be uploaded later.</p> : null}
          {option === "ENTER" ? numberFields : null}
          {option === "UPLOAD" ? (
            <>
              <Field label="PDF, JPG or PNG — from your files, photos or the camera" error={fields.file}>
                <input className={inputClass} type="file" accept="image/*,application/pdf" onChange={(e) => e.target.files?.[0] && void readPhoto(e.target.files[0])} />
              </Field>
              {reading ? <p className="text-xs text-ink-500">Reading your document…</p> : null}
              {ocr?.number ? numberFields : <p className="text-xs text-ink-500">GoKesari&apos;s team checks the file if it can&apos;t be read automatically.</p>}
            </>
          ) : null}
          {option === "SCAN" ? (
            <>
              <Field label="Take a photo of the licence" error={fields.file}>
                <input className={inputClass} type="file" accept="image/*" capture="environment" onChange={(e) => e.target.files?.[0] && void readPhoto(e.target.files[0])} />
              </Field>
              {reading ? <p className="text-xs text-ink-500">Reading your document…</p> : null}
              {file && !reading ? (
                <>
                  <p className="text-xs text-ink-600">{ocr?.number ? "Check what we read and correct it if needed." : "We couldn't read it — type the details."}</p>
                  {numberFields}
                </>
              ) : null}
            </>
          ) : null}
          {option === "LATER" ? (
            <label className="flex items-start gap-3 text-sm text-ink-700">
              <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={promise} onChange={(e) => setPromise(e.target.checked)} data-testid={`v2-licence-${licence.key}-promise`} />
              <span>
                I don&apos;t have this document right now, I will upload it within {v2.promiseDays} days (by {v2.promiseDueLabel}). GoKesari will remind me by e-mail and my
                shop can be suspended if it is not uploaded by then.
              </span>
            </label>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button disabled={busy || reading || !canSave} onClick={() => void save()} data-testid={`v2-licence-${licence.key}-save`}>
            Save
          </Button>
        </>
      )}
    </div>
  );
}

export function V2LicencesStep({ v2, onState, back }: { v2: V2State; onState: (next: unknown) => void; back: ReactNode }) {
  return (
    <V2Card title="Licences for your shop" intro="For each licence: enter its details, upload a file, scan it with the camera — or, where the law allows, upload it later.">
      {v2.licences.length === 0 ? <p className="text-sm text-ink-700">No licence is needed for your type of shop.</p> : null}
      {v2.licences.map((l) => (
        <LicenceCard key={l.key} licence={l} v2={v2} onState={onState} />
      ))}
      <div className="flex gap-2">{back}</div>
    </V2Card>
  );
}

/* ----------------------------------------------------- 6b. agreement, live */

export function SlaStep({ state, busy, send, reload }: { state: V2WizardLike; busy: boolean; send: Send; reload: () => void }) {
  const v2 = state.v2!;
  const [terms, setTerms] = useState(false);
  const [undertaking, setUndertaking] = useState(false);
  if (!state.shop) {
    return (
      <V2Card title="Your seller agreement" intro="Almost done. Next we prepare your personalised seller agreement with your shop's details and licences.">
        <ul className="space-y-1 text-sm text-ink-700" data-testid="v2-sla-summary">
          <li>
            <strong>{v2.names.shopName}</strong>
            {state.shopType ? ` · ${state.shopType.replace(/_/g, " ").toLowerCase()}` : ""}
          </li>
          {state.address ? <li>{`${state.address.addressLine1}, ${state.address.city} ${state.address.pincode}`}</li> : null}
          {v2.licences.map((l) => (
            <li key={l.key}>
              {l.label}: {l.entry ? STATUS_TEXT[l.entry.status].label : "—"}
            </li>
          ))}
          {v2.fee.paidAtIst ? <li>Fee paid on {v2.fee.paidAtIst}</li> : null}
        </ul>
        <Button className="w-full" disabled={busy} onClick={() => void send(`${API}/agreement`, { action: "prepare" })} data-testid="v2-sla-prepare">
          Continue to my seller agreement
        </Button>
      </V2Card>
    );
  }
  if (v2.sla.agreementsEnabled && v2.sla.agreementsRequired) {
    return (
      <V2Card title="Accept your seller agreement" intro="Read your shop's personalised agreements (English, मराठी, हिंदी), tick each one and accept with your name — no code needed now.">
        <AgreementsSigner apiBase={`/api/shops/${state.shop.id}/agreements`} onSigned={reload} registrationAccept />
      </V2Card>
    );
  }
  return (
    <V2Card title="Accept and go live" intro="A copy of your signed agreement is e-mailed to you in English, Marathi and Hindi with your shop's welcome banner and QR code.">
      <details className="rounded-lg border border-[var(--gk-line)] bg-white p-3 text-sm">
        <summary className="cursor-pointer font-semibold text-ink-900">{SELLER_UNDERTAKING_TITLE}</summary>
        <SellerUndertakingClauses />
      </details>
      <label className="flex items-start gap-3 text-sm text-ink-700">
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="v2-sla-terms" />
        <span>{SELLER_TERMS_ACCEPT_TEXT}</span>
      </label>
      <label className="flex items-start gap-3 text-sm text-ink-700">
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={undertaking} onChange={(e) => setUndertaking(e.target.checked)} data-testid="v2-sla-undertaking" />
        <span>{SELLER_UNDERTAKING_PROMISE}</span>
      </label>
      <Button
        className="w-full"
        disabled={busy || !terms || !undertaking}
        onClick={() => void send(`${API}/agreement`, { action: "accept", acceptSellerTerms: terms, acceptUndertaking: undertaking })}
        data-testid="v2-sla-accept"
      >
        Accept and go live
      </Button>
    </V2Card>
  );
}

/** Flow 2, the team's review: what still waits for GoKesari's team, and the way back (?return=). */
export function V2WaitingStep({ state }: { state: V2WizardLike }) {
  const v2 = state.v2!;
  // Owner, 27-Nov-2026: licences never hold go-live (they follow within the documents period); what waits is the
  // GST / PAN check.
  return (
    <V2Card title="Your shop is with GoKesari's team">
      <Alert tone="warning">
        {state.shop?.name} is waiting for a quick check of your GST / PAN details. Your fee is paid. We&apos;ll e-mail you as soon as your shop is live.
      </Alert>
      <p className="text-sm text-ink-700">Until then your shop receives no orders; you can still shop on GoKesari as a customer.</p>
      <ReturnToLink returnTo={v2.returnTo} />
    </V2Card>
  );
}

export function ReturnToLink({ returnTo }: { returnTo: string | null }) {
  if (!returnTo) return null;
  return (
    <a href={returnTo} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white" data-testid="v2-return-to">
      Continue where you left off →
    </a>
  );
}
