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
import { formatRupeesIndian, turnoverSlab, turnoverSlabLabel, type TurnoverFeeRule } from "@/lib/registration-fee";

/**
 * Shop onboarding wizard (docs/shop-onboarding-wizard-2026-10, BRIEF_REDESIGN.md):
 * one step at a time, in the brief's order, shown as a Tile Board at the top —
 * GST? → (no GST) PAN? → Udyam → FSSAI → shop & turnover (fee) → payment →
 * approval email → map → category → product list. Every answer from the server is the
 * whole wizard (services/shop-registration-wizard.ts), so the screen always
 * shows the step the server says comes next, and a returning owner resumes
 * where they left off. Numbers are shown masked; the server never sends them
 * back in full.
 */

type CheckStatus = "NOT_SUBMITTED" | "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED" | "MANUAL_REVIEW";
type Step = "IDENTITY" | "UDYAM" | "FSSAI" | "DETAILS" | "REVIEW" | "PAYMENT" | "WAITING" | "LOCATION" | "CATEGORY" | "PRODUCTS" | "DONE";

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
  feeRule: TurnoverFeeRule;
  setup: { location: boolean; categories: boolean; products: boolean } | null;
  nextStep: Step;
}

/** The brief's ten steps, always shown at the top of the page (Theme 1 Tile Board). */
const TILES = [
  { n: 1, label: "GST number", icon: "🧾" },
  { n: 2, label: "PAN", icon: "🪪" },
  { n: 3, label: "Udyam", icon: "🏭" },
  { n: 4, label: "FSSAI", icon: "🥛" },
  { n: 5, label: "Turnover & fee", icon: "📊" },
  { n: 6, label: "Payment", icon: "💳" },
  { n: 7, label: "Approval", icon: "✅" },
  { n: 8, label: "Location", icon: "📍" },
  { n: 9, label: "Category", icon: "🗂️" },
  { n: 10, label: "Products", icon: "📦" },
] as const;

/** The tile a wizard step belongs to (the PAN tile is the identity step on the no-GSTIN route). */
function tileOf(step: Step, state: WizardState | null): number {
  switch (step) {
    case "IDENTITY":
      return state?.route === "PAN_ONLY" ? 2 : 1;
    case "UDYAM":
      return 3;
    case "FSSAI":
      return 4;
    case "DETAILS":
    case "REVIEW":
      return 5;
    case "PAYMENT":
      return 6;
    case "WAITING":
      return 7;
    case "LOCATION":
      return 8;
    case "CATEGORY":
      return 9;
    case "PRODUCTS":
      return 10;
    case "DONE":
      return 11;
  }
}

/** Steps the owner may open again from a tile (finished ones on the current side of the shop's creation). */
function stepForTile(n: number, state: WizardState): Step | null {
  const open = state.status === "OPEN";
  const approved = state.shop?.status === "APPROVED";
  if (open && (n === 1 || n === 2)) return "IDENTITY";
  if (open && n === 3 && state.canContinue) return "UDYAM";
  if (open && n === 4 && state.canContinue) return "FSSAI";
  if (open && n === 5 && state.canContinue) return "DETAILS";
  if (approved && n === 8) return "LOCATION";
  if (approved && n === 9) return "CATEGORY";
  if (approved && n === 10) return "PRODUCTS";
  return null;
}

const STATUS_BADGE: Record<CheckStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING: { label: "Checking — we'll keep trying", tone: "warning" },
  MANUAL_REVIEW: { label: "Our team will check", tone: "warning" },
  FAILED: { label: "Not verified", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "danger" },
  NOT_SUBMITTED: { label: "Not entered", tone: "neutral" },
};

/**
 * Sends one step. The wizard's own routes answer with the whole wizard; a shop route (map pin,
 * categories — saved on the approved shop) answers with something else, so the wizard is read again.
 */
async function post(
  path: string,
  body?: unknown,
  method: "POST" | "PUT" | "PATCH" = "POST",
): Promise<{ ok: true; data: WizardState } | { ok: false; error: string; fields?: Record<string, string> }> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!response) return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  const payload = await response.json().catch(() => null);
  if (response.ok && payload && !path.startsWith("/api/shops/registration-draft")) {
    const again = await fetch("/api/shops/registration-draft").catch(() => null);
    const next = again?.ok ? await again.json().catch(() => null) : null;
    if (next) return { ok: true, data: next as WizardState };
    return { ok: false, error: "Saved. Reload the page to see the next step." };
  }
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
    <Card className="rounded-2xl border-[var(--gk-line)] p-3 sm:p-5">
      <h2 className="text-base font-semibold text-ink-900 sm:text-lg">{title}</h2>
      {intro ? <p className="mt-0.5 text-sm text-ink-500">{intro}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </Card>
  );
}

function TileSteps({ step, state, onOpen }: { step: Step; state: WizardState | null; onOpen: (s: Step) => void }) {
  const at = tileOf(step, state);
  // A PAN-only registration skips the GST tile; a GSTIN one skips the PAN tile — both count as done.
  const skipped = (n: number) => (n === 1 && state?.route === "PAN_ONLY") || (n === 2 && state?.route === "GSTIN" && at > 2);
  return (
    <ol className="grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Registration steps" data-testid="registration-tiles">
      {TILES.map((t) => {
        const done = t.n < at && !(t.n === 1 && state?.route === "PAN_ONLY");
        const current = t.n === at;
        const target = state ? stepForTile(t.n, state) : null;
        const tone = current
          ? "border-kesari-600 bg-kesari-600 text-white shadow-sm"
          : done
            ? "border-leaf-500 bg-leaf-50 text-leaf-700"
            : skipped(t.n)
              ? "border-cream-200 bg-cream-50 text-ink-400"
              : "border-[var(--gk-line)] bg-white text-ink-700";
        const body = (
          <>
            <span className="text-base leading-none sm:text-lg" aria-hidden>
              {done ? "✓" : t.icon}
            </span>
            <span className="mt-0.5 block text-[0.6875rem] font-semibold leading-tight sm:text-xs">
              {t.n}. {t.label}
            </span>
          </>
        );
        return (
          <li key={t.n} aria-current={current ? "step" : undefined}>
            {target && !current ? (
              <button type="button" onClick={() => onOpen(target)} className={`flex min-h-14 w-full flex-col items-center justify-center rounded-xl border px-1 py-1.5 text-center ${tone}`}>
                {body}
              </button>
            ) : (
              <div className={`flex min-h-14 flex-col items-center justify-center rounded-xl border px-1 py-1.5 text-center ${tone}`}>{body}</div>
            )}
          </li>
        );
      })}
      <li className="sr-only">
        Step {Math.min(at, TILES.length)} of {TILES.length}: {TILES[Math.min(at, TILES.length) - 1].label}
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

  async function send(path: string, body?: unknown, method: "POST" | "PUT" | "PATCH" = "POST"): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setFields({});
    const result = await post(path, body, method);
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
    <div className="space-y-3" data-registration-board>
      <TileSteps step={step} state={state} onOpen={setViewing} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice && !error ? <Alert tone="warning">{notice}</Alert> : null}

      {step === "IDENTITY" ? <IdentityStep state={state} busy={busy} fields={fields} send={send} /> : null}
      {step === "UDYAM" && state ? (
        <OptionalDocStep
          docType="UDYAM"
          title="3. Udyam registration (optional)"
          question="Do you have a Udyam (MSME) registration?"
          placeholder="UDYAM-MH-26-0012345"
          doc={state.udyam}
          busy={busy}
          fields={fields}
          send={send}
          back={back("IDENTITY")}
          prefill={state}
        />
      ) : null}
      {step === "FSSAI" && state ? (
        <OptionalDocStep
          docType="FSSAI"
          title="4. FSSAI licence"
          question="Do you have an FSSAI licence or registration? It is required for shops that sell food (dairy, bakery, sweets, grocery, restaurants)."
          placeholder="14-digit FSSAI number"
          required={state.fssai.required}
          doc={state.fssai}
          busy={busy}
          fields={fields}
          send={send}
          back={back("UDYAM")}
        />
      ) : null}
      {step === "DETAILS" && state ? <DetailsStep state={state} busy={busy} fields={fields} send={send} dealerProgramme={dealerProgramme} back={back("FSSAI")} /> : null}
      {step === "REVIEW" && state ? <ReviewStep state={state} busy={busy} send={send} goTo={setViewing} /> : null}
      {step === "PAYMENT" && state?.shop ? (
        <StepCard title="6. Pay the registration fee" intro="Pay by UPI or card. Your shop goes live as soon as the payment is confirmed.">
          <p className="text-sm text-ink-700">
            <strong>{state.shop.name}</strong>
            {state.shop.registrationNumber ? <> · Shop ID {state.shop.registrationNumber}</> : null}
          </p>
          <RegistrationFeePayButton shopId={state.shop.id} amountPaise={state.shop.feeDuePaise} />
          <Alert tone="warning" title="Pending admin approval until the fee is paid">
            {state.shop.feePaymentStatus === "FAILED" ? "Your last payment did not go through. " : ""}
            Your shop waits for admin approval and receives no orders until the payment clears. You can still shop on GoKesari as a customer. A failed payment
            can be tried again — you are charged once.
          </Alert>
          <Link href="/" className="text-sm font-medium text-kesari-700 underline">
            Browse GoKesari as a customer
          </Link>
        </StepCard>
      ) : null}
      {step === "WAITING" && state?.shop ? (
        <StepCard title="7. Payment received — pending admin approval">
          <Alert tone="warning">
            {state.documents.missing.length > 0
              ? `${state.shop.name} is pending admin approval: ${state.documents.missing
                  .map((t) => SELLER_DOC_LABELS[t as SellerDocType] ?? t)
                  .join(", ")} is not verified yet. We'll email you as soon as your shop is live.`
              : `${state.shop.name} is pending admin approval. We'll email you as soon as your shop is live.`}
          </Alert>
          <p className="text-sm text-ink-700">Until then your shop receives no orders; you can still shop on GoKesari as a customer.</p>
          <div className="flex flex-wrap gap-3 text-sm font-medium">
            <Link href="/shop/verification" className="text-kesari-700 underline">
              See your documents
            </Link>
            <Link href="/" className="text-kesari-700 underline">
              Browse as a customer
            </Link>
          </div>
        </StepCard>
      ) : null}
      {(step === "LOCATION" || step === "CATEGORY" || step === "PRODUCTS" || step === "DONE") && state?.shop ? (
        <Alert tone="success" title={`7. ${state.shop.name} is approved and live`}>
          We&apos;ve emailed you that your registration succeeded{state.shop.registrationNumber ? ` (shop ID ${state.shop.registrationNumber})` : ""} and your shop is ready
          for product upload. Upload the Shop Act and other licences on{" "}
          <Link href="/shop/documents" className="underline">
            Documents
          </Link>{" "}
          — reminders are sent on the 1st and 15th of each month.
        </Alert>
      ) : null}
      {step === "LOCATION" && state?.shop ? <ShopLocationStep shopId={state.shop.id} busy={busy} send={send} /> : null}
      {step === "CATEGORY" && state?.shop ? (
        <ShopCategoryStep shopId={state.shop.id} busy={busy} fields={fields} send={send} initialCategories={initialCategories} initial={state.details?.categoryIds ?? []} />
      ) : null}
      {step === "PRODUCTS" && state?.shop ? (
        <StepCard title="10. Upload your product list" intro="Upload your price list (Excel / CSV) or pick products from GoKesari's catalogue. Customers can order once products are listed.">
          <div className="grid gap-2 sm:grid-cols-2">
            <Link href="/shop/product-import" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white">
              Upload product list
            </Link>
            <Link href="/shop/manage/products" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-cream-200 px-4 text-sm font-medium text-ink-700">
              Add products one by one
            </Link>
          </div>
        </StepCard>
      ) : null}
      {step === "DONE" && state?.shop ? (
        <StepCard title="Registration successful 🎉">
          <p className="text-sm text-ink-700">Your shop is set up: location, categories and products are in place.</p>
          <Link href="/shop" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white">
            Go to my shop
          </Link>
        </StepCard>
      ) : null}
    </div>
  );
}

type Send = (path: string, body?: unknown, method?: "POST" | "PUT" | "PATCH") => Promise<boolean>;

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

/** Step 1 "Do you have a GST number?" → GSTIN; step 2 (no GST) "Do you have a PAN number?" → PAN; neither → the rule. */
function IdentityStep({ state, busy, fields, send }: { state: WizardState | null; busy: boolean; fields: Record<string, string>; send: Send }) {
  const [hasGst, setHasGst] = useState<boolean | null>(state?.route === "PAN_ONLY" ? false : state?.route === "GSTIN" ? true : null);
  const [hasPan, setHasPan] = useState<boolean | null>(state?.route === "PAN_ONLY" ? true : null);
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const [declaration, setDeclaration] = useState(false);
  const panRoute = hasGst === false && hasPan === true;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (panRoute) void send("/api/shops/registration-draft/pan", { pan: number, declaration, consent });
    else void send("/api/shops/registration-draft/gstin", { gstin: number, consent });
  }

  const yesNo = (value: boolean | null, set: (v: boolean) => void, label: string) => (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label}>
      <Button type="button" variant={value === true ? "primary" : "secondary"} onClick={() => set(true)} aria-pressed={value === true}>
        Yes
      </Button>
      <Button type="button" variant={value === false ? "primary" : "secondary"} onClick={() => set(false)} aria-pressed={value === false}>
        No
      </Button>
    </div>
  );

  return (
    <StepCard
      title={hasGst === false ? "2. Do you have a PAN number?" : "1. Do you have a GST number?"}
      intro={
        hasGst === false
          ? "Without GST we check your PAN with the Income Tax record and fill in your name from it."
          : "We check it with the GST record and fill in your PAN, shop name, owner name and registered address — you can review and edit them."
      }
    >
      {state?.gstin && hasGst !== false ? <StatusLine check={state.gstin} /> : null}
      {state?.pan && hasGst === false ? <StatusLine check={state.pan} /> : null}
      {hasGst === false ? (
        <>
          {yesNo(hasPan, setHasPan, "Do you have a PAN number?")}
          <button type="button" className="text-sm font-medium text-kesari-700 underline" onClick={() => setHasGst(true)}>
            I have a GST number after all
          </button>
        </>
      ) : (
        yesNo(hasGst, (v) => {
          setHasGst(v);
          setNumber("");
        }, "Do you have a GST number?")
      )}
      {hasGst === false && hasPan === false ? (
        <Alert tone="warning" title="A valid PAN or GST is required to register" data-testid="no-pan-message">
          GoKesari registers firms with PAN only, or with GST and PAN — shops, professionals (advocates, doctors, CAs), companies, industries and startups.
          Apply for a PAN (it is free and quick online) and come back to register. Meanwhile you can still{" "}
          <Link href="/" className="underline">
            shop on GoKesari as a customer
          </Link>
          .
        </Alert>
      ) : null}
      {hasGst === true || panRoute ? (
        <form onSubmit={submit} className="space-y-3">
          <Field label={panRoute ? "PAN" : "GST number (GSTIN)"} error={fields.gstin ?? fields.pan}>
            <input
              className={`${inputClass} font-mono uppercase`}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              placeholder={panRoute ? "ABCDE1234F" : "27ABCDE1234F1Z5"}
              maxLength={20}
              required
            />
          </Field>
          {panRoute ? <Consent checked={declaration} onChange={setDeclaration} text={GST_DECLARATION_TEXT} /> : null}
          <Consent checked={consent} onChange={setConsent} />
          <Button type="submit" size="lg" className="w-full" disabled={busy || !consent || !number.trim() || (panRoute && !declaration)}>
            {busy ? "Checking with the government record…" : "Check and continue"}
          </Button>
        </form>
      ) : null}
    </StepCard>
  );
}

/** What the GST / PAN record filled in, shown on the step after it; edited on step 5. */
function PrefillSummary({ state }: { state: WizardState }) {
  const p = state.prefill;
  const rows = [
    ["Shop name", p.shopName],
    ["Legal name", p.legalName],
    ["Owner name", p.ownerName],
    ["Registered address", p.address],
    ["PAN", state.pan?.numberMasked ?? null],
  ].filter((r): r is [string, string] => Boolean(r[1]));
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-leaf-300 bg-leaf-50 p-3 text-sm" data-testid="prefill-summary">
      <p className="font-semibold text-leaf-700">Filled in from your {state.route === "PAN_ONLY" ? "PAN" : "GST"} record — you can edit these on step 5</p>
      <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <dt className="text-ink-500">{k}:</dt>
            <dd className="text-ink-900">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---------------------------------------------------- shop & turnover (fee) */

function DetailsStep({
  state,
  busy,
  fields,
  send,
  dealerProgramme,
  back,
}: {
  state: WizardState;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  dealerProgramme: boolean;
  back: ReactNode;
}) {
  const shopTypes = useShopTypes();
  const d = state.details;
  const p = state.prefill;
  const rule = state.feeRule;
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
    couponCode: d?.couponCode ?? "",
    referralCode: d?.referralCode ?? "",
    employeeId: d?.employeeId ?? "",
  });
  // The slab the owner picks; its turnover is sent as the slab's own limit (the last slab: just above the one before).
  const [slab, setSlab] = useState<number | null>(d?.annualTurnoverRupees != null && rule.enabled ? turnoverSlab(d.annualTurnoverRupees, rule) : null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const turnoverFor = (n: number) => rule.slabs[n - 1]?.upToRupees ?? (n > 1 ? (rule.slabs[n - 2]?.upToRupees ?? 0) + 1 : 0);

  function submit(event: FormEvent) {
    event.preventDefault();
    const blank = (v: string) => (v.trim() ? v.trim() : null);
    void send("/api/shops/registration-draft/details", {
      name: form.name,
      ownerName: form.ownerName,
      phone: form.phone.trim(),
      email: blank(form.email),
      shopType: form.shopType,
      categoryIds: d?.categoryIds ?? [],
      annualTurnoverRupees: rule.enabled && slab ? turnoverFor(slab) : null,
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
    <StepCard
      title="5. Shop details & turnover slab"
      intro={p.legalName ? `From the GST record: ${p.legalName}${p.constitution ? ` (${p.constitution})` : ""}. Review, edit and pick your turnover slab.` : "Review your shop details and pick your turnover slab."}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Shop name (as customers know it)" error={fields.name}>
            <input className={inputClass} value={form.name} onChange={set("name")} required maxLength={120} />
          </Field>
          <Field label="Owner name" error={fields.ownerName}>
            <input className={inputClass} value={form.ownerName} onChange={set("ownerName")} required maxLength={120} autoComplete="name" />
          </Field>
          <Field label="Shop mobile number" error={fields.phone}>
            <input className={inputClass} value={form.phone} onChange={set("phone")} required inputMode="numeric" autoComplete="tel-national" maxLength={10} pattern="[6-9][0-9]{9}" />
          </Field>
          <Field label="Shop type" error={fields.shopType} hint="Food shops need an FSSAI licence (step 4).">
            <select className={inputClass} value={form.shopType} onChange={set("shopType")} required>
              <option value="">Choose…</option>
              {shopTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Registered address" error={fields.addressLine1}>
            <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} required maxLength={200} autoComplete="address-line1" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" error={fields.city}>
              <input className={inputClass} value={form.city} onChange={set("city")} required maxLength={120} autoComplete="address-level2" />
            </Field>
            <Field label="PIN code" error={fields.pincode}>
              <input className={inputClass} value={form.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" autoComplete="postal-code" />
            </Field>
          </div>
        </div>
        <details className="text-sm text-ink-700">
          <summary className="cursor-pointer font-medium">More (email, address line 2, area, landmark)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Email (optional)" error={fields.email}>
              <input className={inputClass} type="email" value={form.email} onChange={set("email")} autoComplete="email" />
            </Field>
            <Field label="Address line 2 (optional)">
              <input className={inputClass} value={form.addressLine2} onChange={set("addressLine2")} maxLength={200} autoComplete="address-line2" />
            </Field>
            <Field label="Area (optional)">
              <input className={inputClass} value={form.area} onChange={set("area")} maxLength={120} />
            </Field>
            <Field label="Landmark (optional)">
              <input className={inputClass} value={form.landmark} onChange={set("landmark")} maxLength={200} />
            </Field>
          </div>
        </details>
        {rule.enabled ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink-700">Annual turnover slab — sets your one-time registration fee</legend>
            {fields.annualTurnover ? <p className="mb-1 text-sm text-red-700">{fields.annualTurnover}</p> : null}
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" data-testid="turnover-slabs">
              {rule.slabs.map((s, i) => {
                const n = i + 1;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={slab === n}
                    onClick={() => setSlab(n)}
                    className={`rounded-xl border px-3 py-2 text-left ${slab === n ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`}
                  >
                    <span className="block text-sm font-semibold text-ink-900">{turnoverSlabLabel(n, rule)}</span>
                    <span className="block text-sm text-ink-700">Fee ₹{formatRupeesIndian(Math.round(s.feePaise / 100))} + GST</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Referral code" error={fields.referralCode} hint="Optional unless GoKesari has made it mandatory.">
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
          <Button type="submit" size="lg" disabled={busy || (rule.enabled && slab === null)}>
            {busy ? "Saving…" : "Continue to payment"}
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
  prefill,
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
  /** Udyam, right after the GST / PAN step: what the record filled in. */
  prefill?: WizardState;
}) {
  const [has, setHas] = useState<boolean | null>(doc.has ?? (required ? true : null));
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const canGoOn = doc.done && doc.check && (doc.check.status === "VERIFIED" || doc.check.status === "PENDING" || doc.check.status === "MANUAL_REVIEW");

  return (
    <StepCard
      title={title}
      intro={required ? "Your shop type sells food, so an FSSAI licence or registration is required. Your shop goes live once it is verified." : question}
    >
      {prefill ? <PrefillSummary state={prefill} /> : null}
      <div className={`grid gap-2 ${required ? "grid-cols-1" : "grid-cols-2"}`} role="radiogroup" aria-label={question}>
        <Button type="button" variant={has === true ? "primary" : "secondary"} onClick={() => setHas(true)} aria-pressed={has === true}>
          Yes
        </Button>
        {required ? null : (
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
            No
          </Button>
        )}
      </div>
      <StatusLine check={doc.check} />
      {has ? (
        <form
          className="space-y-3"
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

/* ------------------------------------------------- after approval: map pin */

function ShopLocationStep({ shopId, busy, send }: { shopId: string; busy: boolean; send: Send }) {
  const [manual, setManual] = useState({ latitude: "", longitude: "" });
  const save = (latitude: number, longitude: number) => void send(`/api/shops/${shopId}`, { latitude: String(latitude), longitude: String(longitude) }, "PATCH");
  return (
    <StepCard title="8. Where is your shop?" intro="Search, or drag the pin onto your shop's entrance, then confirm. Customers and riders use this pin.">
      <MapPicker initialCoordinates={null} purpose="shop_registration" onConfirm={(result: MapPickerResult) => save(result.latitude, result.longitude)} />
      <details className="text-sm text-ink-700">
        <summary className="cursor-pointer">Map not loading? Enter the coordinates</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(Number(manual.latitude), Number(manual.longitude));
          }}
          className="mt-3 grid gap-3 sm:grid-cols-3"
        >
          <input className={inputClass} value={manual.latitude} onChange={(e) => setManual({ ...manual, latitude: e.target.value })} placeholder="Latitude" inputMode="decimal" required />
          <input className={inputClass} value={manual.longitude} onChange={(e) => setManual({ ...manual, longitude: e.target.value })} placeholder="Longitude" inputMode="decimal" required />
          <Button type="submit" disabled={busy}>
            Save location
          </Button>
        </form>
      </details>
    </StepCard>
  );
}

/* ----------------------------------------------- after approval: categories */

function ShopCategoryStep({
  shopId,
  busy,
  fields,
  send,
  initialCategories,
  initial,
}: {
  shopId: string;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  initialCategories?: PickerCategory[];
  initial: string[];
}) {
  const [categoryIds, setCategoryIds] = useState<string[]>(initial);
  return (
    <StepCard title="9. What does your shop sell?" intro="Pick your shop's categories — customers find you under them.">
      <ShopCategoryPicker value={categoryIds} onChange={setCategoryIds} error={fields.categoryIds ?? null} initialCategories={initialCategories} />
      <Button type="button" size="lg" className="w-full" disabled={busy || categoryIds.length === 0} onClick={() => void send(`/api/shops/${shopId}/categories`, { categoryIds }, "PUT")}>
        {busy ? "Saving…" : "Save categories"}
      </Button>
    </StepCard>
  );
}

/* ------------------------------------------------------------- Review/pay */

function ReviewStep({ state, busy, send, goTo }: { state: WizardState; busy: boolean; send: Send; goTo: (s: Step) => void }) {
  const d = state.details!;
  const docs = state.documents;
  const rule = state.feeRule;
  const names = (list: string[]) => list.map((t) => SELLER_DOC_LABELS[t as SellerDocType] ?? t).join(", ");
  const slab = rule.enabled && d.annualTurnoverRupees != null ? turnoverSlab(d.annualTurnoverRupees, rule) : null;
  const row = (label: string, value: ReactNode, step: Step) => (
    <div className="flex items-start justify-between gap-3 border-b border-cream-100 py-1.5 last:border-0">
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
    <StepCard title="5. Check your fee and pay" intro="Your shop is created when you continue; then you pay the one-time registration fee by UPI or card.">
      <div>
        {row(state.route === "PAN_ONLY" ? "PAN (no GST)" : "GSTIN", doc(state.route === "PAN_ONLY" ? state.pan : state.gstin, "—"), "IDENTITY")}
        {row("Udyam", state.udyam.has === false ? "Not registered" : doc(state.udyam.check, "—"), "UDYAM")}
        {row("FSSAI", state.fssai.has === false ? "No licence" : doc(state.fssai.check, "—"), "FSSAI")}
        {row("Shop", `${d.name} · ${d.city} ${d.pincode}`, "DETAILS")}
        {slab ? row("Turnover slab", `${turnoverSlabLabel(slab, rule)} — fee ₹${formatRupeesIndian(Math.round(rule.slabs[slab - 1].feePaise / 100))} + GST`, "DETAILS") : null}
      </div>
      {!docs.canSubmit ? (
        <Alert tone="warning" title="A valid PAN or GST is required to register">
          Your {state.route === "PAN_ONLY" ? "PAN" : "GSTIN"} is not verified yet. Go back to step {state.route === "PAN_ONLY" ? 2 : 1} and check it again.
        </Alert>
      ) : (
        <Alert tone="info">
          {docs.needsTeamApproval
            ? `After payment your shop waits for admin approval: ${names(docs.missing)} is not verified yet.`
            : "Your GST / PAN is verified: your shop is approved automatically as soon as the payment is confirmed."}
        </Alert>
      )}
      <Button type="button" size="lg" className="w-full" disabled={busy || !docs.canSubmit} onClick={() => void send("/api/shops/registration-draft/submit")}>
        {busy ? "Creating your shop…" : "Create my shop and pay"}
      </Button>
    </StepCard>
  );
}
