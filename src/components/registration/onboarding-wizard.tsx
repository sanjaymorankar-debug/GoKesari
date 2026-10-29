"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { RegistrationFeePayButton } from "@/components/registration-fee-pay-button";
import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { useShopTypes } from "@/components/use-shop-types";
import { GST_DECLARATION_TEXT, SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";
import { SELLER_DOC_LABELS, type SellerDocType } from "@/lib/kyc/doc-formats";
import { formatRupeesIndian, parseTurnoverRupees } from "@/lib/registration-fee";

/**
 * Shop onboarding wizard (docs/shop-onboarding-wizard-2026-10): one step at a
 * time, in the owner's order — GSTIN (or PAN + declaration) → shop details →
 * Udyam → FSSAI → Shop Act → map → payment. Every answer from the server is the
 * whole wizard (services/shop-registration-wizard.ts), so the screen always
 * shows the step the server says comes next, and a returning owner resumes
 * where they left off. Numbers are shown masked; the server never sends them
 * back in full.
 */

type CheckStatus = "NOT_SUBMITTED" | "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED" | "MANUAL_REVIEW";
type Step = "IDENTITY" | "DETAILS" | "UDYAM" | "FSSAI" | "SHOP_ACT" | "LOCATION" | "REVIEW" | "PAYMENT" | "WAITING" | "DONE";

interface CheckView {
  numberMasked: string | null;
  status: CheckStatus;
  errorCode: string | null;
  message: string | null;
  validUntil?: string | null;
}

interface DocView {
  has: boolean | null;
  check: CheckView | null;
  done: boolean;
}

interface Details {
  name: string;
  ownerName: string;
  phone: string;
  email: string | null;
  shopType: string;
  categoryIds: string[];
  annualTurnoverRupees: number | null;
  couponCode: string | null;
  referralCode: string | null;
  employeeId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
}

export interface WizardState {
  status: "OPEN" | "SUBMITTED" | "COMPLETED" | "ABANDONED";
  route: "GSTIN" | "PAN_ONLY" | null;
  gstin: CheckView | null;
  pan: (CheckView & { holderType: string | null }) | null;
  noGstDeclared: boolean;
  prefill: {
    shopName: string | null;
    legalName: string | null;
    tradeName: string | null;
    ownerName: string | null;
    constitution: string | null;
    address: string | null;
    stateCode: string | null;
    pincode: string | null;
  };
  canContinue: boolean;
  details: Details | null;
  foodShop: boolean;
  udyam: DocView;
  fssai: DocView & { required: boolean };
  shopAct: DocView;
  location: { latitude: string; longitude: string; address: string | null } | null;
  documents: {
    verified: string[];
    missing: string[];
    inReview: string[];
    promised: boolean;
    promiseDays: number;
    canSubmit: boolean;
    needsTeamApproval: boolean;
  };
  shop: { id: string; name: string; registrationNumber: string | null; status: string; feeDuePaise: number; feePaymentStatus: string } | null;
  nextStep: Step;
}

const STEP_LABELS: { key: Step; label: string }[] = [
  { key: "IDENTITY", label: "GSTIN / PAN" },
  { key: "DETAILS", label: "Shop details" },
  { key: "UDYAM", label: "Udyam" },
  { key: "FSSAI", label: "FSSAI" },
  { key: "SHOP_ACT", label: "Shop Act" },
  { key: "LOCATION", label: "Location" },
  { key: "REVIEW", label: "Payment" },
];
const STEP_INDEX: Record<Step, number> = { IDENTITY: 0, DETAILS: 1, UDYAM: 2, FSSAI: 3, SHOP_ACT: 4, LOCATION: 5, REVIEW: 6, PAYMENT: 6, WAITING: 7, DONE: 7 };

const STATUS_BADGE: Record<CheckStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING: { label: "Checking — we'll keep trying", tone: "warning" },
  MANUAL_REVIEW: { label: "Our team will check", tone: "warning" },
  FAILED: { label: "Not verified", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "danger" },
  NOT_SUBMITTED: { label: "Not entered", tone: "neutral" },
};

async function post(path: string, body?: unknown): Promise<{ ok: true; data: WizardState } | { ok: false; error: string; fields?: Record<string, string> }> {
  const response = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!response) return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  const payload = await response.json().catch(() => null);
  if (response.ok && payload) return { ok: true, data: payload as WizardState };
  return {
    ok: false,
    error: payload?.error?.message ?? "Something went wrong. Please try again.",
    fields: payload?.error?.details?.fields,
  };
}

function StatusLine({ check }: { check: CheckView | null }) {
  if (!check) return null;
  const badge = STATUS_BADGE[check.status];
  const tone = check.status === "VERIFIED" ? "success" : check.status === "FAILED" || check.status === "EXPIRED" ? "danger" : "warning";
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <span className="font-mono">{check.numberMasked}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {check.validUntil ? <span className="text-xs text-ink-500">valid until {check.validUntil}</span> : null}
      </p>
      {check.message ? <Alert tone={tone}>{check.message}</Alert> : null}
    </div>
  );
}

function Consent({ checked, onChange, text = SELLER_VERIFICATION_CONSENT_TEXT }: { checked: boolean; onChange: (v: boolean) => void; text?: string }) {
  return (
    <label className="flex items-start gap-3 text-sm text-ink-700">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{text}</span>
    </label>
  );
}

function StepCard({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-ink-500">{intro}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

function Progress({ step }: { step: Step }) {
  const at = STEP_INDEX[step];
  return (
    <ol className="mb-4 flex gap-1" aria-label="Registration steps">
      {STEP_LABELS.map((s, i) => (
        <li key={s.key} className="flex-1">
          <span className={`block h-1.5 rounded-full ${i < at ? "bg-leaf-500" : i === at ? "bg-kesari-600" : "bg-cream-200"}`} />
          <span className={`mt-1 hidden text-xs sm:block ${i === at ? "font-medium text-ink-900" : "text-ink-500"}`}>{s.label}</span>
        </li>
      ))}
      <li className="sr-only" aria-current="step">
        Step {Math.min(at + 1, STEP_LABELS.length)} of {STEP_LABELS.length}: {STEP_LABELS[Math.min(at, STEP_LABELS.length - 1)].label}
      </li>
    </ol>
  );
}

export function OnboardingWizard({
  initial,
  initialCategories,
  dealerProgramme,
}: {
  initial: WizardState | null;
  initialCategories?: PickerCategory[];
  dealerProgramme: boolean;
}) {
  const [state, setState] = useState<WizardState | null>(initial);
  // The owner may look back at a finished step; null = the step the server says is next.
  const [viewing, setViewing] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // A check that let the owner go on but is not VERIFIED: its message stays on screen on the next step.
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const step: Step = viewing ?? state?.nextStep ?? "IDENTITY";

  async function send(path: string, body?: unknown): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setFields({});
    const result = await post(path, body);
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setFields(result.fields ?? {});
      return false;
    }
    setState(result.data);
    setViewing(null);
    setNotice(noticeFor(path, body, result.data));
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  const back = (to: Step) => (
    <Button type="button" variant="ghost" onClick={() => setViewing(to)} disabled={busy}>
      Back
    </Button>
  );

  return (
    <div className="space-y-4">
      {state?.status !== "SUBMITTED" && state?.status !== "COMPLETED" ? <Progress step={step} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice && !error ? <Alert tone="warning">{notice}</Alert> : null}

      {step === "IDENTITY" ? <IdentityStep state={state} busy={busy} fields={fields} send={send} /> : null}
      {step === "DETAILS" && state ? <DetailsStep state={state} busy={busy} fields={fields} send={send} initialCategories={initialCategories} dealerProgramme={dealerProgramme} back={back("IDENTITY")} /> : null}
      {step === "UDYAM" && state ? (
        <OptionalDocStep
          docType="UDYAM"
          title="Udyam registration"
          question="Do you have a Udyam (MSME) registration?"
          placeholder="UDYAM-MH-26-0012345"
          doc={state.udyam}
          busy={busy}
          fields={fields}
          send={send}
          back={back("DETAILS")}
        />
      ) : null}
      {step === "FSSAI" && state ? (
        <OptionalDocStep
          docType="FSSAI"
          title="FSSAI licence"
          question="Do you have an FSSAI licence or registration?"
          placeholder="14-digit FSSAI number"
          required={state.fssai.required}
          doc={state.fssai}
          busy={busy}
          fields={fields}
          send={send}
          back={back("UDYAM")}
        />
      ) : null}
      {step === "SHOP_ACT" && state ? <ShopActStep doc={state.shopAct} busy={busy} fields={fields} send={send} back={back("FSSAI")} /> : null}
      {step === "LOCATION" && state ? <LocationStep state={state} busy={busy} send={send} back={back("SHOP_ACT")} /> : null}
      {step === "REVIEW" && state ? <ReviewStep state={state} busy={busy} send={send} goTo={setViewing} /> : null}
      {step === "PAYMENT" && state?.shop ? (
        <StepCard
          title="Pay the registration fee"
          intro={
            state.documents.needsTeamApproval
              ? "Your shop is created. Pay the one-time registration fee; GoKesari's team then checks your registration and approves it."
              : "Your shop is created. Pay the one-time registration fee to go live."
          }
        >
          <p className="text-sm text-ink-700">
            <strong>{state.shop.name}</strong>
            {state.shop.registrationNumber ? <> · Shop ID {state.shop.registrationNumber}</> : null}
          </p>
          <RegistrationFeePayButton shopId={state.shop.id} amountPaise={state.shop.feeDuePaise} />
          <p className="text-xs text-ink-500">
            After paying you&apos;ll see the result.{" "}
            {state.documents.needsTeamApproval ? "Your shop goes live once our team approves it." : "Your shop goes live as soon as the payment is confirmed."} A failed
            payment can be tried again — you are charged once.
          </p>
        </StepCard>
      ) : null}
      {step === "WAITING" && state?.shop ? (
        <StepCard title="Payment received — almost there">
          <Alert tone="warning">
            {state.documents.missing.length > 0
              ? `${state.shop.name} is waiting for GoKesari's team to approve it. Provide the documents you promised (${state.documents.missing
                  .map((t) => SELLER_DOC_LABELS[t as SellerDocType] ?? t)
                  .join(", ")}) within ${state.documents.promiseDays} days; we'll tell you as soon as your shop is live.`
              : `${state.shop.name} is waiting for a document check by our team. We'll tell you as soon as your shop is live.`}
          </Alert>
          <Link href="/shop/verification" className="text-sm font-medium text-kesari-700 underline">
            See your documents
          </Link>
        </StepCard>
      ) : null}
      {step === "DONE" && state?.shop ? (
        <StepCard title="Registration successful 🎉">
          <Alert tone="success" title={`${state.shop.name} is live on GoKesari`}>
            We&apos;ve sent you an email with your shop ID{state.shop.registrationNumber ? ` (${state.shop.registrationNumber})` : ""}. Add your products to
            start selling.
          </Alert>
          {state.documents.missing.length > 0 ? (
            <Alert tone="info">
              Still to provide: {state.documents.missing.map((t) => SELLER_DOC_LABELS[t as SellerDocType] ?? t).join(", ")}. Upload them on{" "}
              <Link href="/shop/documents" className="underline">
                Documents
              </Link>{" "}
              — reminders are sent on the 1st and 15th of each month, and a shop still without them is suspended after the third.
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href="/shop/manage/products" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white">
              Add products
            </Link>
            <Link href="/shop" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-cream-200 px-4 text-sm font-medium text-ink-700">
              Go to my shop
            </Link>
          </div>
        </StepCard>
      ) : null}
    </div>
  );
}

type Send = (path: string, body?: unknown) => Promise<boolean>;

/** The message of the check just sent, when the wizard moved on without it being VERIFIED. */
function noticeFor(path: string, body: unknown, next: WizardState): string | null {
  let check: CheckView | null = null;
  if (path.endsWith("/gstin")) check = next.gstin?.status === "VERIFIED" ? next.pan : next.gstin;
  else if (path.endsWith("/pan")) check = next.pan;
  else if (path.endsWith("/documents") && body && typeof body === "object" && "number" in body) {
    const docType = (body as unknown as { docType: string }).docType;
    check = docType === "UDYAM" ? next.udyam.check : docType === "FSSAI" ? next.fssai.check : next.shopAct.check;
  }
  if (!check || check.status === "VERIFIED" || !check.message) return null;
  // A failed check keeps the owner on its step, where the message is already shown.
  return check.status === "FAILED" || check.status === "EXPIRED" ? null : check.message;
}

/* ------------------------------------------------------------ GSTIN / PAN */

function IdentityStep({ state, busy, fields, send }: { state: WizardState | null; busy: boolean; fields: Record<string, string>; send: Send }) {
  const [noGst, setNoGst] = useState(state?.route === "PAN_ONLY");
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const [declaration, setDeclaration] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (noGst) void send("/api/shops/registration-draft/pan", { pan: number, declaration, consent });
    else void send("/api/shops/registration-draft/gstin", { gstin: number, consent });
  }

  return (
    <StepCard
      title={noGst ? "Your PAN" : "Your GSTIN"}
      intro={noGst ? "Without a GSTIN we check the PAN with the Income Tax record." : "We check it with the GST record and fill in your shop's name and address from it."}
    >
      {state?.gstin && !noGst ? <StatusLine check={state.gstin} /> : null}
      {state?.pan ? <StatusLine check={state.pan} /> : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label={noGst ? "PAN" : "GSTIN"} error={fields.gstin ?? fields.pan}>
          <input
            className={`${inputClass} font-mono uppercase`}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            inputMode="text"
            placeholder={noGst ? "ABCDE1234F" : "27ABCDE1234F1Z5"}
            maxLength={20}
            required
          />
        </Field>
        {noGst ? <Consent checked={declaration} onChange={setDeclaration} text={GST_DECLARATION_TEXT} /> : null}
        <Consent checked={consent} onChange={setConsent} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || !consent || !number.trim() || (noGst && !declaration)}>
          {busy ? "Checking with the government record…" : "Check and continue"}
        </Button>
      </form>
      <button type="button" className="text-sm font-medium text-kesari-700 underline" onClick={() => setNoGst(!noGst)}>
        {noGst ? "I have a GSTIN" : "I don't have a GSTIN"}
      </button>
    </StepCard>
  );
}

/* ----------------------------------------------------------- shop details */

function DetailsStep({
  state,
  busy,
  fields,
  send,
  initialCategories,
  dealerProgramme,
  back,
}: {
  state: WizardState;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  initialCategories?: PickerCategory[];
  dealerProgramme: boolean;
  back: ReactNode;
}) {
  const shopTypes = useShopTypes();
  const d = state.details;
  const p = state.prefill;
  const [form, setForm] = useState({
    name: d?.name ?? p.shopName ?? "",
    ownerName: d?.ownerName ?? p.ownerName ?? "",
    phone: d?.phone ?? "",
    email: d?.email ?? "",
    shopType: d?.shopType ?? "",
    addressLine1: d?.addressLine1 ?? p.address ?? "",
    addressLine2: d?.addressLine2 ?? "",
    area: d?.area ?? "",
    city: d?.city ?? "",
    state: d?.state ?? "",
    pincode: d?.pincode ?? p.pincode ?? "",
    landmark: d?.landmark ?? "",
    turnover: d?.annualTurnoverRupees != null ? String(d.annualTurnoverRupees) : "",
    couponCode: d?.couponCode ?? "",
    referralCode: d?.referralCode ?? "",
    employeeId: d?.employeeId ?? "",
  });
  const [categoryIds, setCategoryIds] = useState<string[]>(d?.categoryIds ?? []);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const turnover = parseTurnoverRupees(form.turnover);

  function submit(event: FormEvent) {
    event.preventDefault();
    const blank = (v: string) => (v.trim() ? v.trim() : null);
    void send("/api/shops/registration-draft/details", {
      name: form.name,
      ownerName: form.ownerName,
      phone: form.phone.trim(),
      email: blank(form.email),
      shopType: form.shopType,
      categoryIds,
      annualTurnoverRupees: turnover,
      couponCode: blank(form.couponCode),
      referralCode: blank(form.referralCode),
      employeeId: blank(form.employeeId),
      addressLine1: form.addressLine1,
      addressLine2: blank(form.addressLine2),
      area: blank(form.area),
      city: form.city,
      state: blank(form.state),
      pincode: form.pincode.trim(),
      landmark: blank(form.landmark),
    });
  }

  return (
    <StepCard title="Shop details" intro={p.legalName ? `From the GST record: ${p.legalName}${p.constitution ? ` (${p.constitution})` : ""}. Check and complete the rest.` : "Tell us about your shop."}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Shop name (as customers know it)" error={fields.name}>
          <input className={inputClass} value={form.name} onChange={set("name")} required maxLength={120} />
        </Field>
        <Field label="Owner name" error={fields.ownerName}>
          <input className={inputClass} value={form.ownerName} onChange={set("ownerName")} required maxLength={120} autoComplete="name" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shop mobile number" error={fields.phone}>
            <input className={inputClass} value={form.phone} onChange={set("phone")} required inputMode="numeric" autoComplete="tel-national" maxLength={10} pattern="[6-9][0-9]{9}" />
          </Field>
          <Field label="Email (optional)" error={fields.email}>
            <input className={inputClass} type="email" value={form.email} onChange={set("email")} autoComplete="email" />
          </Field>
        </div>
        <Field label="Shop type" error={fields.shopType} hint={state.foodShop ? "A food shop needs an FSSAI licence." : undefined}>
          <select className={inputClass} value={form.shopType} onChange={set("shopType")} required>
            <option value="">Choose…</option>
            {shopTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-700">What you sell</span>
          <ShopCategoryPicker value={categoryIds} onChange={setCategoryIds} error={fields.categoryIds ?? null} initialCategories={initialCategories} />
        </div>
        <Field label="Address" error={fields.addressLine1}>
          <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} required maxLength={200} autoComplete="address-line1" />
        </Field>
        <Field label="Address line 2 (optional)">
          <input className={inputClass} value={form.addressLine2} onChange={set("addressLine2")} maxLength={200} autoComplete="address-line2" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Area (optional)">
            <input className={inputClass} value={form.area} onChange={set("area")} maxLength={120} />
          </Field>
          <Field label="City" error={fields.city}>
            <input className={inputClass} value={form.city} onChange={set("city")} required maxLength={120} autoComplete="address-level2" />
          </Field>
          <Field label="PIN code" error={fields.pincode}>
            <input className={inputClass} value={form.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" autoComplete="postal-code" />
          </Field>
        </div>
        <Field label="Annual turnover (₹)" error={fields.annualTurnover} hint={turnover !== null ? `₹${formatRupeesIndian(turnover)} — sets your registration fee.` : "Sets your one-time registration fee."}>
          <input className={inputClass} value={form.turnover} onChange={set("turnover")} inputMode="numeric" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Referral code (optional)" error={fields.referralCode}>
            <input className={`${inputClass} uppercase`} value={form.referralCode} onChange={set("referralCode")} maxLength={32} />
          </Field>
          <Field label="Coupon code (optional)" error={fields.couponCode}>
            <input className={`${inputClass} uppercase`} value={form.couponCode} onChange={set("couponCode")} maxLength={40} />
          </Field>
        </div>
        {dealerProgramme ? (
          <Field label="GoKesari employee who helped you (optional)">
            <input className={inputClass} value={form.employeeId} onChange={set("employeeId")} maxLength={120} />
          </Field>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {back}
          <Button type="submit" size="lg" disabled={busy || categoryIds.length === 0}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* --------------------------------------------------------- Udyam / FSSAI */

function OptionalDocStep({
  docType,
  title,
  question,
  placeholder,
  required = false,
  doc,
  busy,
  fields,
  send,
  back,
}: {
  docType: "UDYAM" | "FSSAI";
  title: string;
  question: string;
  placeholder: string;
  required?: boolean;
  doc: DocView;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  back: ReactNode;
}) {
  const [has, setHas] = useState<boolean | null>(doc.has ?? (required ? true : null));
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const canGoOn = doc.done && doc.check && (doc.check.status === "VERIFIED" || doc.check.status === "PENDING" || doc.check.status === "MANUAL_REVIEW");

  return (
    <StepCard
      title={title}
      intro={
        required
          ? "Your shop sells food, so an FSSAI licence or registration is required. If you don't have it now, you can promise it — your shop then goes live only once it is provided and approved."
          : question
      }
    >
      {
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={question}>
          <Button type="button" variant={has === true ? "primary" : "secondary"} onClick={() => setHas(true)} aria-pressed={has === true}>
            Yes
          </Button>
          <Button
            type="button"
            variant={has === false ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={has === false}
            onClick={() => {
              setHas(false);
              void send("/api/shops/registration-draft/documents", { docType, has: false });
            }}
          >
            {required ? "Not now" : "No"}
          </Button>
        </div>
      }
      <StatusLine check={doc.check} />
      {has ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send("/api/shops/registration-draft/documents", { docType, number, consent });
          }}
        >
          <Field label={`${docType === "UDYAM" ? "Udyam" : "FSSAI"} number`} error={fields.number}>
            <input className={`${inputClass} font-mono uppercase`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder={placeholder} autoComplete="off" required />
          </Field>
          <Consent checked={consent} onChange={setConsent} />
          <Button type="submit" size="lg" className="w-full" disabled={busy || !consent || !number.trim()}>
            {busy ? "Checking…" : "Check and continue"}
          </Button>
        </form>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {back}
        {canGoOn ? <span className="text-sm text-ink-500">Checked — you can continue from the next step.</span> : null}
      </div>
    </StepCard>
  );
}

/* ---------------------------------------------------------------- Shop Act */

function ShopActStep({ doc, busy, fields, send, back }: { doc: DocView; busy: boolean; fields: Record<string, string>; send: Send; back: ReactNode }) {
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  return (
    <StepCard
      title="Shop Act (Gumasta) licence"
      intro="Enter the licence number as printed on your Shop Act certificate. Where the government record can't be checked online, our team reviews it before your shop goes live."
    >
      <StatusLine check={doc.check} />
      {doc.has === false ? <Alert tone="info">You said you don&apos;t have it now. You&apos;ll promise to provide it before paying.</Alert> : null}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send("/api/shops/registration-draft/documents", { docType: "SHOP_ACT", number, consent });
        }}
      >
        <Field label="Shop Act licence number" error={fields.number}>
          <input className={`${inputClass} uppercase`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. PII/KOTHRUD/II/12345" autoComplete="off" required />
        </Field>
        <Consent checked={consent} onChange={setConsent} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || !consent || !number.trim()}>
          {busy ? "Checking…" : "Check and continue"}
        </Button>
      </form>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={busy}
        onClick={() => void send("/api/shops/registration-draft/documents", { docType: "SHOP_ACT", has: false })}
      >
        I don&apos;t have it now
      </Button>
      {back}
    </StepCard>
  );
}

/* -------------------------------------------------------------------- Map */

function LocationStep({ state, busy, send, back }: { state: WizardState; busy: boolean; send: Send; back: ReactNode }) {
  const [picked, setPicked] = useState<MapPickerResult | null>(null);
  const [manual, setManual] = useState({ latitude: state.location?.latitude ?? "", longitude: state.location?.longitude ?? "" });
  const initial = state.location ? { latitude: Number(state.location.latitude), longitude: Number(state.location.longitude) } : null;

  function saveManual(event: FormEvent) {
    event.preventDefault();
    void send("/api/shops/registration-draft/location", { latitude: Number(manual.latitude), longitude: Number(manual.longitude) });
  }

  return (
    <StepCard title="Where is your shop?" intro="Search, or drag the pin onto your shop's entrance, then confirm. Customers and riders use this pin.">
      <MapPicker
        initialCoordinates={initial}
        purpose="shop_registration"
        onConfirm={(result) => {
          setPicked(result);
          void send("/api/shops/registration-draft/location", { latitude: result.latitude, longitude: result.longitude, address: result.formattedAddress });
        }}
      />
      {picked ? <p className="text-sm text-ink-500">{picked.formattedAddress}</p> : null}
      <details className="text-sm text-ink-700">
        <summary className="cursor-pointer">Map not loading? Enter the coordinates</summary>
        <form onSubmit={saveManual} className="mt-3 grid gap-3 sm:grid-cols-3">
          <input className={inputClass} value={manual.latitude} onChange={(e) => setManual({ ...manual, latitude: e.target.value })} placeholder="Latitude" inputMode="decimal" required />
          <input className={inputClass} value={manual.longitude} onChange={(e) => setManual({ ...manual, longitude: e.target.value })} placeholder="Longitude" inputMode="decimal" required />
          <Button type="submit" disabled={busy}>
            Save location
          </Button>
        </form>
      </details>
      {back}
    </StepCard>
  );
}

/* ------------------------------------------------------------- Review/pay */

function ReviewStep({ state, busy, send, goTo }: { state: WizardState; busy: boolean; send: Send; goTo: (s: Step) => void }) {
  const d = state.details!;
  const docs = state.documents;
  const [promise, setPromise] = useState(docs.promised);
  const names = (list: string[]) => list.map((t) => SELLER_DOC_LABELS[t as SellerDocType] ?? t).join(", ");
  const needsPromise = docs.missing.length > 0;
  const row = (label: string, value: ReactNode, step: Step) => (
    <div className="flex items-start justify-between gap-3 border-b border-cream-100 py-2 last:border-0">
      <div>
        <p className="text-xs text-ink-500">{label}</p>
        <div className="text-sm text-ink-900">{value}</div>
      </div>
      <button type="button" className="text-sm text-kesari-700 underline" onClick={() => goTo(step)}>
        Change
      </button>
    </div>
  );
  const doc = (check: CheckView | null, fallback: string) => (check ? <StatusLine check={{ ...check, message: null }} /> : fallback);
  return (
    <StepCard title="Check and pay" intro="Your shop is created when you continue; then you pay the one-time registration fee.">
      <div>
        {row(state.route === "PAN_ONLY" ? "PAN (no GSTIN)" : "GSTIN", doc(state.route === "PAN_ONLY" ? state.pan : state.gstin, "—"), "IDENTITY")}
        {row("Shop", `${d.name} · ${d.city} ${d.pincode}`, "DETAILS")}
        {row("Udyam", state.udyam.has === false ? "Not registered" : doc(state.udyam.check, "—"), "UDYAM")}
        {row("FSSAI", state.fssai.has === false ? "No licence" : doc(state.fssai.check, "—"), "FSSAI")}
        {row("Shop Act", state.shopAct.has === false ? "Not now" : doc(state.shopAct.check, "—"), "SHOP_ACT")}
        {row("Location", state.location?.address ?? `${state.location?.latitude}, ${state.location?.longitude}`, "LOCATION")}
      </div>
      <div className="space-y-2 rounded-lg border border-cream-200 p-3 text-sm" data-testid="review-documents">
        <p className="font-semibold text-ink-900">Documents</p>
        <p className="text-ink-700">Verified: {docs.verified.length > 0 ? names(docs.verified) : "none yet"}</p>
        {needsPromise ? <p className="text-ink-700">Not verified yet: {names(docs.missing)}</p> : null}
        {docs.inReview.length > 0 ? <p className="text-ink-700">Reviewed by our team: your &quot;not GST-registered&quot; declaration</p> : null}
      </div>
      {!docs.canSubmit ? (
        <Alert tone="warning">Get at least one document verified (your PAN or GSTIN) before paying the registration fee.</Alert>
      ) : null}
      {docs.canSubmit && needsPromise ? (
        <label className="flex items-start gap-2 rounded-lg border border-cream-200 p-3 text-sm text-ink-800">
          <input type="checkbox" className="mt-1" checked={promise} onChange={(e) => setPromise(e.target.checked)} />
          <span>
            I will provide all relevant documents within {docs.promiseDays} days. I understand my shop goes live only after GoKesari&apos;s team approves it,
            and that it can be suspended if the documents are not provided.
          </span>
        </label>
      ) : null}
      <Alert tone="info">
        {docs.needsTeamApproval
          ? "After payment, GoKesari's team checks your registration and approves your shop."
          : "Your documents are verified: your shop goes live as soon as the payment is confirmed."}
      </Alert>
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={busy || !docs.canSubmit || (needsPromise && !promise)}
        onClick={() => void send("/api/shops/registration-draft/submit", needsPromise ? { promiseDocuments: true } : undefined)}
      >
        {busy ? "Creating your shop…" : "Create my shop and pay"}
      </Button>
    </StepCard>
  );
}

