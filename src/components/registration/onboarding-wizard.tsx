"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { ReferralRequestDialog } from "@/components/referral-request-dialog";
import { RegistrationFeePayButton } from "@/components/registration-fee-pay-button";
import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { useShopTypes } from "@/components/use-shop-types";
import { GST_DECLARATION_TEXT, SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";
import { SELLER_DOC_LABELS, type SellerDocType } from "@/lib/kyc/doc-formats";
import { formatRupeesIndian, turnoverSlab, turnoverSlabLabel, type TurnoverFeeRule } from "@/lib/registration-fee";
import { DocumentScan } from "./document-scan";
import { StarterShelf } from "./starter-shelf";

/**
 * Shop onboarding wizard — owner brief 08-Nov-2026 (docs/shop-onboarding-identity-first-2026-11):
 * identity first, and what the government record says fills the rest.
 *
 *   1 Verify  "Verify your business": the referral code and "Do you have a GST number?" — the
 *             GSTIN (its PAN is taken from it) or, without one, the PAN. Nothing goes on until it
 *             is verified. The owner name is asked only when the record gave none.
 *   2 Address "Confirm your shop address", pre-filled from the record
 *   3 Map pin "Mark your shop location on the map"
 *   4 Shop    the shop name (pre-filled from the GST trade / legal name), type, phone, turnover
 *             (FSSAI here for a food shop)
 *   5 Pay     the registration fee
 *   6 Live    "Your onboarding is complete…" and Add Products
 *   7 Products categories, then products
 *
 * Every answer from the server is the whole wizard (services/shop-registration-wizard.ts), so the
 * screen always shows the step the server says comes next, and a returning owner resumes where
 * they left off. Numbers are shown masked; the server never sends them back in full. The Android
 * and iOS apps show this same page.
 */

type CheckStatus = "NOT_SUBMITTED" | "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED" | "MANUAL_REVIEW";
type Step =
  | "IDENTITY"
  | "EMAIL"
  | "OWNER"
  | "ADDRESS"
  | "PIN"
  | "SHOP"
  | "FSSAI"
  | "REVIEW"
  | "PAYMENT"
  | "WAITING"
  | "LIVE"
  | "LOCATION"
  | "CATEGORY"
  | "PRODUCTS"
  | "DONE";

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

interface Address {
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
}

interface Details extends Address {
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
    state: string | null;
    city: string | null;
    pincode: string | null;
  };
  canContinue: boolean;
  details: Details | null;
  ownerName: string | null;
  address: Address | null;
  foodShop: boolean;
  udyam: DocView;
  fssai: DocView & { required: boolean };
  shopAct: DocView;
  location: { latitude: string; longitude: string; address: string | null } | null;
  referral: { answered: boolean; code: string | null; required: boolean };
  email: { account: string | null; shop: string | null; confirmed: boolean };
  documentsLater: boolean | null;
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
  /** The fee covers this many months and then renews (rule shopMembership). */
  membershipMonths: number;
  setup: { location: boolean; categories: boolean; products: boolean } | null;
  nextStep: Step;
}

/**
 * The registration's steps, always shown at the top of the page (Theme 1 Tile Board) — the one
 * checklist on the screen. Minutes per tile (Phase 2, F4): the five before payment add up to the
 * 5-minute target to go live.
 */
const TILES = [
  { n: 1, label: "Verify", icon: "🛡️", minutes: 1 },
  { n: 2, label: "Address", icon: "🏠", minutes: 1 },
  { n: 3, label: "Map pin", icon: "📍", minutes: 1 },
  { n: 4, label: "Shop name", icon: "🏪", minutes: 1 },
  { n: 5, label: "Pay", icon: "💳", minutes: 1 },
  { n: 6, label: "Live", icon: "🚀", minutes: 0 },
  { n: 7, label: "Products", icon: "📦", minutes: 2 },
] as const;
/** The last tile before the shop goes live. */
const PAY_TILE = 5;

/** The tile a wizard step belongs to. */
function tileOf(step: Step): number {
  switch (step) {
    case "IDENTITY":
    // Only a mobile-only account (no email) or an owner changing it sees the email screen.
    case "EMAIL":
    case "OWNER":
      return 1;
    case "ADDRESS":
      return 2;
    case "PIN":
      return 3;
    case "SHOP":
    case "FSSAI":
      return 4;
    case "REVIEW":
    case "PAYMENT":
      return 5;
    case "WAITING":
    case "LIVE":
    case "LOCATION":
      return 6;
    case "CATEGORY":
    case "PRODUCTS":
      return 7;
    case "DONE":
      return 8;
  }
}

/** Steps the owner may open again from a tile (finished ones on the current side of the shop's creation). */
function stepForTile(n: number, state: WizardState): Step | null {
  const open = state.status === "OPEN";
  const approved = state.shop?.status === "APPROVED";
  const verified = state.canContinue && state.referral.answered;
  if (open && n === 1) return "IDENTITY";
  if (open && n === 2 && verified && state.ownerName) return "ADDRESS";
  if (open && n === 3 && verified && state.address && tileOf(state.nextStep) > 2) return "PIN";
  if (open && n === 4 && verified && state.location) return "SHOP";
  if (approved && n === 6) return "LIVE";
  if (approved && n === 7) return state.setup?.categories ? "PRODUCTS" : "CATEGORY";
  return null;
}

const STATUS_BADGE: Record<CheckStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING: { label: "Not verified yet", tone: "warning" },
  MANUAL_REVIEW: { label: "Not verified", tone: "warning" },
  FAILED: { label: "Not verified", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "danger" },
  NOT_SUBMITTED: { label: "Not entered", tone: "neutral" },
};

/** "Verified from GST" / "Verified from PAN" (owner brief 08-Nov-2026), next to a field the record filled. */
function VerifiedFrom({ state }: { state: WizardState }) {
  return (
    <span className="ml-1 inline-flex items-center rounded-full bg-leaf-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-leaf-700" data-testid="verified-from">
      ✓ Verified from {state.route === "PAN_ONLY" ? "PAN" : "GST"}
    </span>
  );
}

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;

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

function Consent({ checked, onChange, text = SELLER_VERIFICATION_CONSENT_TEXT, short }: { checked: boolean; onChange: (v: boolean) => void; text?: string; short?: string }) {
  // The verify screen fits a phone (owner brief 08-Nov-2026): one line, the full text a tap away.
  if (short) {
    return (
      <div className="text-sm text-ink-700">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span>{short}</span>
        </label>
        <details className="ml-8 text-xs text-ink-600">
          <summary className="cursor-pointer underline">Read in full</summary>
          <p className="mt-1">{text}</p>
        </details>
      </div>
    );
  }
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
  const at = tileOf(step);
  // "About N min left" (onboarding Phase B, G21): the rough minutes of the tiles still ahead —
  // to go live before payment, to the first products after it.
  const ahead = TILES.filter((t) => t.n >= at && (at <= PAY_TILE ? t.n <= PAY_TILE : t.n > PAY_TILE));
  const minutes = ahead.reduce((sum, t) => sum + t.minutes, 0);
  const shown = Math.min(at, TILES.length);
  return (
    <div className="space-y-1.5">
      {at <= TILES.length ? (
        <p className="text-sm text-ink-600" data-testid="registration-progress">
          <strong className="text-ink-900">
            Step {shown} of {TILES.length}
          </strong>
          {minutes > 0 ? ` · about ${minutes} min ${at <= PAY_TILE ? "to go live" : "to your first products"}` : null}
        </p>
      ) : null}
      <ol className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 sm:gap-2" aria-label="Registration steps" data-testid="registration-tiles">
        {TILES.map((t) => {
          const done = t.n < at;
          const current = t.n === at;
          const target = state ? stepForTile(t.n, state) : null;
          const tone = current
            ? "border-kesari-600 bg-kesari-600 text-white shadow-sm"
            : done
              ? "border-leaf-500 bg-leaf-50 text-leaf-700"
              : "border-[var(--gk-line)] bg-white text-ink-700";
          const body = (
            <>
              <span className="text-base leading-none sm:text-lg" aria-hidden>
                {done ? "✓" : t.icon}
              </span>
              <span className="mt-0.5 block text-xs font-semibold leading-tight">
                {t.n}. {t.label}
              </span>
            </>
          );
          return (
            <li key={t.n} aria-current={current ? "step" : undefined}>
              {target && !current ? (
                <button type="button" onClick={() => onOpen(target)} className={`flex min-h-12 w-full flex-col items-center justify-center rounded-xl border px-1 py-1 text-center ${tone}`}>
                  {body}
                </button>
              ) : (
                <div className={`flex min-h-12 flex-col items-center justify-center rounded-xl border px-1 py-1 text-center ${tone}`}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function OnboardingWizard({
  initial,
  initialCategories,
  dealerProgramme,
  initialReferralCode = null,
  referralRequired = false,
}: {
  initial: WizardState | null;
  initialCategories?: PickerCategory[];
  dealerProgramme: boolean;
  /** A distributor's or dealer's link (?ref= / ?code=) fills in the referral code. */
  initialReferralCode?: string | null;
  /** Before the draft exists: the admin's setting referral_required_shop. */
  referralRequired?: boolean;
}) {
  const [state, setState] = useState<WizardState | null>(initial);
  // The owner may look back at a finished step; null = the step the server says is next.
  const [viewing, setViewing] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // A check that let the owner go on but is not VERIFIED (the GSTIN's own PAN): its message stays on the next step.
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
    setNotice(noticeFor(path, result.data));
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  /** Reads the wizard again after a change made outside its own routes (the starter shelf). */
  async function refresh() {
    const response = await fetch("/api/shops/registration-draft").catch(() => null);
    const next = response?.ok ? ((await response.json().catch(() => null)) as WizardState | null) : null;
    if (next) {
      setState(next);
      setViewing(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Back keeps everything verified and typed: it only shows an earlier step again.
  const back = (to: Step) => (
    <Button type="button" variant="ghost" onClick={() => setViewing(to)} disabled={busy}>
      Back
    </Button>
  );

  return (
    <div className="space-y-3" data-registration-board>
      <TileSteps step={step} state={state} onOpen={setViewing} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice && !error && step !== "IDENTITY" ? <Alert tone="warning">{notice}</Alert> : null}

      {step === "IDENTITY" ? (
        <VerifyStep
          state={state}
          initialReferralCode={initialReferralCode}
          referralRequired={state?.referral.required ?? referralRequired}
          busy={busy}
          fields={fields}
          send={send}
          next={() => setViewing(null)}
        />
      ) : null}
      {step === "EMAIL" && state ? <EmailStep state={state} busy={busy} fields={fields} send={send} back={back(state.status === "OPEN" && state.details ? "SHOP" : "IDENTITY")} /> : null}
      {step === "OWNER" && state ? <OwnerStep state={state} busy={busy} fields={fields} send={send} back={back("IDENTITY")} /> : null}
      {step === "ADDRESS" && state ? <AddressStep state={state} busy={busy} fields={fields} send={send} back={back(state.prefill.ownerName ? "IDENTITY" : "OWNER")} /> : null}
      {step === "PIN" && state ? <PinStep state={state} busy={busy} fields={fields} send={send} back={back("ADDRESS")} /> : null}
      {step === "SHOP" && state ? (
        <ShopStep state={state} busy={busy} fields={fields} send={send} dealerProgramme={dealerProgramme} changeEmail={() => setViewing("EMAIL")} back={back("PIN")} />
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
          back={back("SHOP")}
        />
      ) : null}
      {step === "REVIEW" && state ? <ReviewStep state={state} busy={busy} send={send} goTo={setViewing} /> : null}
      {step === "PAYMENT" && state?.shop ? (
        <StepCard title="5. Pay the registration fee" intro="Pay by UPI or card. Your shop goes live as soon as the payment is confirmed.">
          <p className="text-sm text-ink-700">
            <strong>{state.shop.name}</strong>
            {state.shop.registrationNumber ? <> · Shop ID {state.shop.registrationNumber}</> : null}
          </p>
          <RegistrationFeePayButton shopId={state.shop.id} amountPaise={state.shop.feeDuePaise} />
          <Alert tone="warning" title="Pending until the fee is paid">
            {state.shop.feePaymentStatus === "FAILED" ? "Your last payment did not go through. " : ""}
            Your shop is not live and receives no orders until the payment clears. You can still shop on GoKesari as a customer. A failed payment can be
            tried again — you are charged once.
          </Alert>
          <Link href="/" className="text-sm font-medium text-kesari-700 underline">
            Browse GoKesari as a customer
          </Link>
        </StepCard>
      ) : null}
      {step === "WAITING" && state?.shop ? (
        <StepCard title="6. Payment received — pending admin approval">
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
      {step === "LIVE" && state?.shop ? (
        <LiveStep state={state} addProducts={() => setViewing(state.setup?.categories ? "PRODUCTS" : "CATEGORY")} />
      ) : null}
      {step === "LOCATION" && state?.shop ? (
        <ShopLocationStep
          title="6. Your shop's address and map pin"
          initial={state.location}
          address={state.details}
          busy={busy}
          fields={fields}
          save={(latitude, longitude, address) =>
            void send(`/api/shops/${state.shop!.id}`, { ...address, latitude: String(latitude), longitude: String(longitude) }, "PATCH")
          }
        />
      ) : null}
      {step === "CATEGORY" && state?.shop ? (
        <ShopCategoryStep
          shopId={state.shop.id}
          busy={busy}
          fields={fields}
          send={send}
          initialCategories={initialCategories}
          initial={state.details?.categoryIds ?? []}
          onSaved={() => setViewing("PRODUCTS")}
        />
      ) : null}
      {step === "PRODUCTS" && state?.shop ? (
        <StepCard
          title="7. Add your products"
          intro="We've picked the products shops like yours sell most, priced at MRP. Check them and publish — customers can order as soon as they are listed."
        >
          <StarterShelf shopId={state.shop.id} onDone={refresh} />
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
          {/* Onboarding Phase 2 (WP3): the two set-up steps left after going live, each one tap away. */}
          <div className="grid gap-2 sm:grid-cols-2" data-testid="done-next-steps">
            <Link href="/shop/bank-account" className="flex min-h-14 items-center gap-3 rounded-xl border border-[var(--gk-line)] bg-white px-3 py-2 text-sm">
              <span aria-hidden className="text-xl">🏦</span>
              <span>
                <strong className="block text-ink-900">Get paid</strong>
                <span className="text-ink-600">Add your bank account — payouts need a verified account.</span>
              </span>
            </Link>
            <Link href="/shop/setup/delivery" className="flex min-h-14 items-center gap-3 rounded-xl border border-[var(--gk-line)] bg-white px-3 py-2 text-sm">
              <span aria-hidden className="text-xl">🛵</span>
              <span>
                <strong className="block text-ink-900">How you deliver</strong>
                <span className="text-ink-600">Own staff, GoKesari riders or pickup only.</span>
              </span>
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link href="/shop" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white">
              Go to my shop
            </Link>
            <a href="/shop/register?new=1" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-cream-200 px-4 text-sm font-medium text-ink-700">
              Register another shop
            </a>
          </div>
        </StepCard>
      ) : null}
    </div>
  );
}

type Send = (path: string, body?: unknown, method?: "POST" | "PUT" | "PATCH") => Promise<boolean>;

/** The GSTIN's own PAN, checked in the background: when it is not verified, the owner is told on the next step. */
function noticeFor(path: string, next: WizardState): string | null {
  if (!path.endsWith("/gstin") || next.gstin?.status !== "VERIFIED") return null;
  const pan = next.pan;
  if (!pan || pan.status === "VERIFIED" || !pan.message) return null;
  return pan.message;
}

/* ------------------------------------------------ 1. Verify your business */

/**
 * Owner brief 08-Nov-2026: the first screen after sign-in. The referral code (owner, 08-Nov: "on
 * the first screen with PAN / GST number"), then "Do you have a GST number?" — Yes: the GSTIN,
 * whose PAN is taken from it; No: the PAN and the "not GST-registered" declaration. The owner
 * goes on only once the number is verified; a failure says why and the owner tries again.
 */
function VerifyStep({
  state,
  initialReferralCode,
  referralRequired,
  busy,
  fields,
  send,
  next,
}: {
  state: WizardState | null;
  initialReferralCode: string | null;
  referralRequired: boolean;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  /** Leaves the screen for the step the server says is next (when the owner came back to look). */
  next: () => void;
}) {
  const [code, setCode] = useState(state?.referral.code ?? initialReferralCode ?? "");
  const [requesting, setRequesting] = useState(false);
  const [hasGst, setHasGst] = useState<boolean | null>(state?.route === "PAN_ONLY" ? false : state?.route === "GSTIN" ? true : null);
  const [number, setNumber] = useState("");
  const [declaration, setDeclaration] = useState(state?.noGstDeclared ?? false);
  const [consent, setConsent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const check = hasGst === false ? (state?.route === "PAN_ONLY" ? state.pan : null) : state?.route === "GSTIN" ? state.gstin : null;
  const verified = Boolean(state?.canContinue && state.referral.answered);
  const typed = number.trim().toUpperCase().replace(/\s+/g, "");

  async function verify(event: FormEvent) {
    event.preventDefault();
    const pattern = hasGst ? GSTIN_PATTERN : PAN_PATTERN;
    if (!pattern.test(typed)) {
      setProblem(hasGst ? "Enter the 15-character GSTIN as on your GST certificate, for example 27ABCDE1234F1Z5." : "Enter the 10-character PAN, for example ABCDE1234F.");
      return;
    }
    setProblem(null);
    // The code first (a required or unknown code is refused before any paid check), then the number.
    const codeNow = code.trim() || null;
    if (!state?.referral.answered || (state.referral.code ?? null) !== codeNow) {
      if (!(await send("/api/shops/registration-draft/referral", { referralCode: codeNow }))) return;
    }
    if (hasGst) await send("/api/shops/registration-draft/gstin", { gstin: typed, consent });
    else await send("/api/shops/registration-draft/pan", { pan: typed, declaration, consent });
  }

  return (
    <StepCard title="Verify your business" intro="We check your GST or PAN with the government records and fill in your shop's details from them.">
      {requesting ? <ReferralRequestDialog prefill={{}} onClose={() => setRequesting(false)} /> : null}
      <form onSubmit={verify} className="space-y-3">
        <Field label={referralRequired ? "Referral code" : "Referral code (optional)"} error={fields.referralCode}>
          <div className="flex gap-2">
            <input
              className={`${inputClass} font-mono uppercase tracking-widest`}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="AB12CD34"
              maxLength={32}
              required={referralRequired}
              data-testid="wizard-referral-code"
            />
            <button type="button" className="min-h-11 shrink-0 text-sm font-medium text-kesari-700 underline" onClick={() => setRequesting(true)}>
              Request a code
            </button>
          </div>
        </Field>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-ink-900">Do you have a GST number?</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Do you have a GST number?">
            <Button
              type="button"
              variant={hasGst === true ? "primary" : "secondary"}
              aria-pressed={hasGst === true}
              onClick={() => {
                setHasGst(true);
                setNumber("");
                setProblem(null);
              }}
              data-testid="has-gst-yes"
            >
              Yes
            </Button>
            <Button
              type="button"
              variant={hasGst === false ? "primary" : "secondary"}
              aria-pressed={hasGst === false}
              onClick={() => {
                setHasGst(false);
                setNumber("");
                setProblem(null);
              }}
              data-testid="has-gst-no"
            >
              No
            </Button>
          </div>
        </fieldset>

        {hasGst !== null ? (
          <>
            <Field
              label={hasGst ? "Enter your 15-digit GSTIN" : "Enter your 10-character PAN"}
              error={problem ?? (hasGst ? fields.gstin : fields.pan)}
              hint={hasGst ? "Your PAN, business name and address are taken from it." : "Your name is taken from the Income Tax record."}
            >
              <input
                className={`${inputClass} font-mono uppercase`}
                value={number}
                onChange={(e) => setNumber(e.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder={check?.numberMasked && check.status === "VERIFIED" ? `${check.numberMasked} — verified` : hasGst ? "27ABCDE1234F1Z5" : "ABCDE1234F"}
                maxLength={hasGst ? 15 : 10}
                data-testid={hasGst ? "gstin-input" : "pan-input"}
              />
            </Field>
            {hasGst === false ? (
              <Consent checked={declaration} onChange={setDeclaration} text={GST_DECLARATION_TEXT} short="My shop is not registered under GST." />
            ) : null}
            <Consent checked={consent} onChange={setConsent} short="I agree that GoKesari checks this number with the government record." />
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={busy || !consent || !typed || (hasGst === false && !declaration) || (referralRequired && code.trim().length < 3)}
              data-testid="verify-identity"
            >
              {busy ? "Verifying…" : hasGst ? "Verify GSTIN" : "Verify PAN"}
            </Button>
            <details open={scanning} onToggle={(e) => setScanning((e.target as HTMLDetailsElement).open)} className="text-sm text-ink-700">
              <summary className="cursor-pointer">📷 Read it from a photo of your {hasGst ? "GST certificate" : "PAN card"}</summary>
              {scanning ? (
                <div className="mt-2">
                  <DocumentScan
                    busy={busy}
                    onConfirm={(found) => {
                      const hit = found.find((f) => f.docType === (hasGst ? "GSTIN" : "PAN"));
                      if (hit) setNumber(hit.number.toUpperCase());
                      setScanning(false);
                    }}
                  />
                </div>
              ) : null}
            </details>
          </>
        ) : null}
      </form>

      <StatusLine check={check} />
      {verified ? (
        <div className="flex justify-end">
          <Button type="button" size="lg" onClick={next} disabled={busy}>
            Continue
          </Button>
        </div>
      ) : null}
    </StepCard>
  );
}

/* --------------------------------------------------------- 1b. owner name */

/** Owner brief 08-Nov-2026: the GST (or PAN) record named no owner — only that one field is asked. */
function OwnerStep({ state, busy, fields, send, back }: { state: WizardState; busy: boolean; fields: Record<string, string>; send: Send; back: ReactNode }) {
  const [ownerName, setOwnerName] = useState(state.ownerName ?? "");
  const business = state.prefill.legalName ?? state.prefill.tradeName;
  return (
    <StepCard
      title="Owner name"
      intro={
        business
          ? `Your ${state.route === "PAN_ONLY" ? "PAN" : "GST"} record is for ${business}${state.prefill.constitution ? ` (${state.prefill.constitution})` : ""} and names no owner. Who owns or runs the shop?`
          : "Your record names no owner. Who owns or runs the shop?"
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("/api/shops/registration-draft/owner", { ownerName });
        }}
      >
        <Field label="Owner name" error={fields.ownerName}>
          <input className={inputClass} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" data-testid="owner-name" />
        </Field>
        <div className="flex items-center justify-between gap-2">
          {back}
          <Button type="submit" size="lg" disabled={busy || ownerName.trim().length < 2}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* ----------------------------------------------------------- 2. address */

/** Owner brief 08-Nov-2026: the address from the GST (or PAN) record, confirmed or corrected — the shop may be elsewhere. */
function AddressStep({ state, busy, fields, send, back }: { state: WizardState; busy: boolean; fields: Record<string, string>; send: Send; back: ReactNode }) {
  const a = state.address;
  const fromRecord = Boolean(state.prefill.address) && !state.details;
  const [form, setForm] = useState({
    addressLine1: a?.addressLine1 ?? "",
    addressLine2: a?.addressLine2 ?? "",
    area: a?.area ?? "",
    city: a?.city ?? "",
    state: a?.state ?? "",
    pincode: a?.pincode ?? "",
    landmark: a?.landmark ?? "",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const blank = (v: string) => (v.trim() ? v.trim() : null);
  return (
    <StepCard
      title="Confirm your shop address"
      intro={
        state.prefill.address
          ? "This is the address on your record. If your shop is somewhere else, change it to the shop's address."
          : "Your record gave no address — enter your shop's address."
      }
    >
      {state.ownerName ? (
        <p className="text-sm text-ink-700" data-testid="owner-line">
          Owner: <strong>{state.ownerName}</strong>
          {state.prefill.ownerName === state.ownerName ? <VerifiedFrom state={state} /> : null}
        </p>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("/api/shops/registration-draft/address", {
            addressLine1: form.addressLine1,
            addressLine2: blank(form.addressLine2),
            area: blank(form.area),
            city: form.city,
            state: blank(form.state),
            pincode: form.pincode.trim(),
            landmark: blank(form.landmark),
          });
        }}
      >
        <Field
          label={
            <>
              Address{fromRecord && form.addressLine1 === state.prefill.address ? <VerifiedFrom state={state} /> : null}
            </>
          }
          error={fields.addressLine1}
        >
          <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} required minLength={3} maxLength={200} autoComplete="address-line1" data-testid="address-line1" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City" error={fields.city}>
            <input className={inputClass} value={form.city} onChange={set("city")} required maxLength={120} autoComplete="address-level2" data-testid="address-city" />
          </Field>
          <Field label="PIN code" error={fields.pincode}>
            <input className={inputClass} value={form.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" autoComplete="postal-code" data-testid="address-pincode" />
          </Field>
        </div>
        <Field label="State" error={fields.state}>
          <input className={inputClass} value={form.state} onChange={set("state")} maxLength={60} autoComplete="address-level1" />
        </Field>
        <details className="text-sm text-ink-700">
          <summary className="cursor-pointer font-medium">More (address line 2, area, landmark)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
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
        <div className="flex items-center justify-between gap-2">
          {back}
          <Button type="submit" size="lg" disabled={busy} data-testid="address-continue">
            {busy ? "Saving…" : "Confirm address"}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* ----------------------------------------------------------- 3. map pin */

/** Owner brief 08-Nov-2026: the shop on the map before payment — current location or a dropped pin. */
function PinStep({ state, busy, fields, send, back }: { state: WizardState; busy: boolean; fields: Record<string, string>; send: Send; back: ReactNode }) {
  const [manual, setManual] = useState({ latitude: "", longitude: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const start = state.location ? { latitude: Number(state.location.latitude), longitude: Number(state.location.longitude) } : null;
  const a = state.address;

  function save(latitude: number, longitude: number, address: string | null) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setProblem("Please enter the latitude and longitude as numbers, for example 18.5204 and 73.8567.");
      return;
    }
    setProblem(null);
    void send("/api/shops/registration-draft/location", { latitude, longitude, address });
  }

  return (
    <StepCard title="Mark your shop location on the map" intro="Search, use your current location, or drag the pin onto your shop's entrance, then confirm. Customers and riders use it to find you.">
      {a ? (
        <p className="text-sm text-ink-700" data-testid="pin-address">
          {a.addressLine1}, {a.city} {a.pincode}
        </p>
      ) : null}
      {problem || fields.location ? <Alert tone="danger">{problem ?? fields.location}</Alert> : null}
      <MapPicker initialCoordinates={start} purpose="shop_registration" onConfirm={(result: MapPickerResult) => save(result.latitude, result.longitude, result.formattedAddress || null)} />
      <details className="text-sm text-ink-700">
        <summary className="cursor-pointer">Map not loading? Enter the coordinates</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(Number(manual.latitude), Number(manual.longitude), null);
          }}
          className="mt-3 grid gap-3 sm:grid-cols-3"
        >
          <input className={inputClass} value={manual.latitude} onChange={(e) => setManual({ ...manual, latitude: e.target.value })} placeholder="Latitude" inputMode="decimal" required data-testid="pin-latitude" />
          <input className={inputClass} value={manual.longitude} onChange={(e) => setManual({ ...manual, longitude: e.target.value })} placeholder="Longitude" inputMode="decimal" required data-testid="pin-longitude" />
          <Button type="submit" disabled={busy} data-testid="pin-save">
            Save location
          </Button>
        </form>
      </details>
      <div className="flex items-center justify-between gap-2">{back}</div>
    </StepCard>
  );
}

/* ---------------------------------------------------------- 4. shop name */

/** Owner brief 08-Nov-2026: the shop name, pre-filled from the GST trade or legal name; type, phone and turnover (the fee). */
function ShopStep({
  state,
  busy,
  fields,
  send,
  dealerProgramme,
  changeEmail,
  back,
}: {
  state: WizardState;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  dealerProgramme: boolean;
  /** Opens the email screen to use another address (confirmed with an emailed code). */
  changeEmail: () => void;
  back: ReactNode;
}) {
  const shopTypes = useShopTypes();
  const d = state.details;
  const p = state.prefill;
  const rule = state.feeRule;
  const [form, setForm] = useState({
    name: d?.name ?? p.shopName ?? "",
    phone: d?.phone ?? "",
    shopType: d?.shopType ?? "",
    couponCode: d?.couponCode ?? "",
    employeeId: d?.employeeId ?? "",
  });
  // The slab the owner picks; its turnover is sent as the slab's own limit (the last slab: just above the one before).
  const [slab, setSlab] = useState<number | null>(d?.annualTurnoverRupees != null && rule.enabled ? turnoverSlab(d.annualTurnoverRupees, rule) : null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const turnoverFor = (n: number) => rule.slabs[n - 1]?.upToRupees ?? (n > 1 ? (rule.slabs[n - 2]?.upToRupees ?? 0) + 1 : 0);
  const blank = (v: string) => (v.trim() ? v.trim() : null);

  function submit(event: FormEvent) {
    event.preventDefault();
    void send("/api/shops/registration-draft/details", {
      name: form.name,
      // The owner name and address come from their own steps; the email and referral code too.
      ownerName: null,
      phone: form.phone.trim(),
      email: null,
      shopType: form.shopType,
      categoryIds: d?.categoryIds ?? [],
      annualTurnoverRupees: rule.enabled && slab ? turnoverFor(slab) : null,
      couponCode: blank(form.couponCode),
      referralCode: null,
      employeeId: blank(form.employeeId),
    });
  }

  return (
    <StepCard title="Your shop name" intro={p.shopName ? "Taken from your GST record — the name customers will see. You can change it." : "The name customers will see."}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={<>Shop name{p.shopName && form.name === p.shopName ? <VerifiedFrom state={state} /> : null}</>} error={fields.name}>
            <input className={inputClass} value={form.name} onChange={set("name")} required minLength={2} maxLength={120} data-testid="shop-name" />
          </Field>
          <Field label="Shop mobile number" error={fields.phone}>
            <input className={inputClass} value={form.phone} onChange={set("phone")} required inputMode="numeric" autoComplete="tel-national" maxLength={10} pattern="[6-9][0-9]{9}" data-testid="shop-phone" />
          </Field>
          <Field label="Shop type" error={fields.shopType} hint="Food shops need an FSSAI licence — we'll ask for it next.">
            <select className={inputClass} value={form.shopType} onChange={set("shopType")} required data-testid="shop-type">
              <option value="">Choose…</option>
              {shopTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {state.email.shop ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--gk-line)] bg-white px-3 py-1.5 text-sm" data-testid="shop-email-line">
            <p className="min-w-0 text-ink-600">
              Shop email: <strong className="break-all text-ink-900">{state.email.shop}</strong>
            </p>
            <button type="button" className="min-h-11 text-sm font-medium text-kesari-700 underline" onClick={changeEmail}>
              Change
            </button>
          </div>
        ) : null}
        {rule.enabled ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink-700">Annual turnover — sets your yearly registration fee</legend>
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
                    className={`rounded-xl border px-3 py-1.5 text-left ${slab === n ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`}
                  >
                    <span className="block text-sm font-semibold text-ink-900">{turnoverSlabLabel(n, rule)}</span>
                    <span className="block text-xs text-ink-700">Fee {formatRupeesIndian(Math.round(s.feePaise / 100))} + GST</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <details className="text-sm text-ink-700">
          <summary className="cursor-pointer font-medium">Coupon code{dealerProgramme ? " or GoKesari employee" : ""} (optional)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Coupon code (optional)" error={fields.couponCode}>
              <input className={`${inputClass} uppercase`} value={form.couponCode} onChange={set("couponCode")} maxLength={40} />
            </Field>
            {dealerProgramme ? (
              <Field label="GoKesari employee who helped you (optional)">
                <input className={inputClass} value={form.employeeId} onChange={set("employeeId")} maxLength={120} />
              </Field>
            ) : null}
          </div>
        </details>
        <div className="flex items-center justify-between gap-2">
          {back}
          <Button type="submit" size="lg" disabled={busy || (rule.enabled && slab === null)} data-testid="shop-continue">
            {busy ? "Saving…" : "Continue to payment"}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* ---------------------------------------------------------- 6. live */

/** Owner brief 08-Nov-2026: the words after a successful payment, and Add Products right below them. */
function LiveStep({ state, addProducts }: { state: WizardState; addProducts: () => void }) {
  return (
    <StepCard title={`🎉 ${state.shop!.name} is live`}>
      <Alert tone="success">
        <strong data-testid="onboarding-complete">Your onboarding is complete. Your shop is now live and accepting orders.</strong>
        {state.shop?.registrationNumber ? <span className="block text-sm">Shop ID {state.shop.registrationNumber} — we&apos;ve emailed you the same.</span> : null}
      </Alert>
      <p className="text-sm text-ink-900" data-testid="add-products-prompt">
        Add your products now so customers can find them and place orders with you.
      </p>
      <Button type="button" size="lg" className="w-full" onClick={addProducts} data-testid="add-products">
        Add Products
      </Button>
      <p className="text-xs text-ink-600">
        Upload the Shop Act and other licences on{" "}
        <Link href="/shop/documents" className="underline">
          Documents
        </Link>{" "}
        whenever you are ready.
      </p>
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
  scanned,
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
  /** The number read from the owner's photo, to check or correct. */
  scanned?: string;
}) {
  const [has, setHas] = useState<boolean | null>(doc.has ?? (required || scanned ? true : null));
  const [number, setNumber] = useState(scanned ?? "");
  const [consent, setConsent] = useState(false);
  const canGoOn = doc.done && doc.check && (doc.check.status === "VERIFIED" || doc.check.status === "PENDING" || doc.check.status === "MANUAL_REVIEW");

  return (
    <StepCard
      title={title}
      intro={required ? "Your shop type sells food, so an FSSAI licence or registration is required. Your shop goes live once it is verified." : question}
    >
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

/** The shop's address as saved on the shop (PATCH /api/shops/{id}), corrected on the location step. */
interface ShopAddress {
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  landmark: string | null;
  city: string;
  pincode: string;
}

/**
 * Step 8, after payment (owner brief 30 Oct 2026): the shop's address — filled in from step 5, to
 * check or correct — and its map pin, saved on the shop together.
 */
function ShopLocationStep({
  title,
  initial,
  address,
  busy,
  fields,
  save,
}: {
  title: string;
  initial: { latitude: string; longitude: string } | null;
  address: Details | null;
  busy: boolean;
  fields: Record<string, string>;
  save: (latitude: number, longitude: number, address: ShopAddress) => void;
}) {
  const [manual, setManual] = useState({ latitude: "", longitude: "" });
  const [form, setForm] = useState({
    addressLine1: address?.addressLine1 ?? "",
    addressLine2: address?.addressLine2 ?? "",
    area: address?.area ?? "",
    landmark: address?.landmark ?? "",
    city: address?.city ?? "",
    pincode: address?.pincode ?? "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const start = initial ? { latitude: Number(initial.latitude), longitude: Number(initial.longitude) } : null;

  function saveWith(latitude: number, longitude: number) {
    if (form.addressLine1.trim().length < 3 || form.city.trim().length < 2 || !/^[1-9]\d{5}$/.test(form.pincode.trim())) {
      setProblem("Please fill in the address, city and a 6-digit PIN code first.");
      return;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setProblem("Please enter the latitude and longitude as numbers, for example 18.5204 and 73.8567.");
      return;
    }
    setProblem(null);
    const blank = (v: string) => (v.trim() ? v.trim() : null);
    save(latitude, longitude, {
      addressLine1: form.addressLine1.trim(),
      addressLine2: blank(form.addressLine2),
      area: blank(form.area),
      landmark: blank(form.landmark),
      city: form.city.trim(),
      pincode: form.pincode.trim(),
    });
  }

  return (
    <StepCard title={title} intro="Check your shop's address, then search or drag the pin onto your shop's entrance and confirm. Customers and riders use them to find you.">
      <div className="grid gap-3 sm:grid-cols-2" data-testid="location-address">
        <Field label="Shop address" error={fields.addressLine1}>
          <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} required maxLength={200} autoComplete="address-line1" />
        </Field>
        <Field label="Address line 2 (optional)" error={fields.addressLine2}>
          <input className={inputClass} value={form.addressLine2} onChange={set("addressLine2")} maxLength={200} autoComplete="address-line2" />
        </Field>
        <Field label="Area (optional)" error={fields.area}>
          <input className={inputClass} value={form.area} onChange={set("area")} maxLength={120} />
        </Field>
        <Field label="Landmark (optional)" error={fields.landmark}>
          <input className={inputClass} value={form.landmark} onChange={set("landmark")} maxLength={200} />
        </Field>
        <Field label="City" error={fields.city}>
          <input className={inputClass} value={form.city} onChange={set("city")} required maxLength={120} autoComplete="address-level2" />
        </Field>
        <Field label="PIN code" error={fields.pincode}>
          <input className={inputClass} value={form.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" autoComplete="postal-code" />
        </Field>
      </div>
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
      <MapPicker initialCoordinates={start} purpose="shop_registration" onConfirm={(result: MapPickerResult) => saveWith(result.latitude, result.longitude)} />
      <details className="text-sm text-ink-700">
        <summary className="cursor-pointer">Map not loading? Enter the coordinates</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveWith(Number(manual.latitude), Number(manual.longitude));
          }}
          className="mt-3 grid gap-3 sm:grid-cols-3"
        >
          <input className={inputClass} value={manual.latitude} onChange={(e) => setManual({ ...manual, latitude: e.target.value })} placeholder="Latitude" inputMode="decimal" required />
          <input className={inputClass} value={manual.longitude} onChange={(e) => setManual({ ...manual, longitude: e.target.value })} placeholder="Longitude" inputMode="decimal" required />
          <Button type="submit" disabled={busy}>
            Save address and location
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
  onSaved,
}: {
  shopId: string;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  initialCategories?: PickerCategory[];
  initial: string[];
  /** On to the products once the categories are saved. */
  onSaved: () => void;
}) {
  const [categoryIds, setCategoryIds] = useState<string[]>(initial);
  return (
    <StepCard title="7. What does your shop sell?" intro="Pick your shop's categories — customers find you under them. Then add your products.">
      <ShopCategoryPicker value={categoryIds} onChange={setCategoryIds} error={fields.categoryIds ?? null} initialCategories={initialCategories} />
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={busy || categoryIds.length === 0}
        onClick={async () => {
          if (await send(`/api/shops/${shopId}/categories`, { categoryIds }, "PUT")) onSaved();
        }}
      >
        {busy ? "Saving…" : "Save and add products"}
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
    <div className="flex items-start justify-between gap-3 border-b border-cream-100 py-1 last:border-0">
      <div className="min-w-0">
        <p className="text-xs text-ink-500">{label}</p>
        <div className="text-sm text-ink-900">{value}</div>
      </div>
      <button type="button" className="min-h-11 text-sm text-kesari-700 underline" onClick={() => goTo(step)}>
        Change
      </button>
    </div>
  );
  const identity = state.route === "PAN_ONLY" ? state.pan : state.gstin;
  return (
    <StepCard title="5. Check and pay" intro="Your shop is created when you continue; then you pay the registration fee by UPI or card.">
      <div>
        {row(state.route === "PAN_ONLY" ? "PAN (no GST)" : "GSTIN", identity ? <StatusLine check={{ ...identity, message: null }} /> : "—", "IDENTITY")}
        {row("Referral code", state.referral.code ?? "None", "IDENTITY")}
        {row("Owner", d.ownerName, state.prefill.ownerName ? "IDENTITY" : "OWNER")}
        {row("Shop address", `${d.addressLine1}, ${d.city} ${d.pincode}`, "ADDRESS")}
        {row("Map pin", state.location ? "Placed" : "—", "PIN")}
        {row("Shop", `${d.name} · ${state.email.shop ?? ""}`, "SHOP")}
        {state.foodShop ? row("FSSAI", state.fssai.check ? <StatusLine check={{ ...state.fssai.check, message: null }} /> : "—", "FSSAI") : null}
        {slab ? row("Turnover", `${turnoverSlabLabel(slab, rule)} — fee ${formatRupeesIndian(Math.round(rule.slabs[slab - 1].feePaise / 100))} + GST`, "SHOP") : null}
      </div>
      {!docs.canSubmit ? (
        <Alert tone="warning" title="Your GST or PAN is not verified">
          Go back to step 1 and verify your {state.route === "PAN_ONLY" ? "PAN" : "GSTIN"} again.
        </Alert>
      ) : docs.needsTeamApproval ? (
        <Alert tone="info">{`After payment your shop waits for admin approval: ${names(docs.missing)} is not verified yet.`}</Alert>
      ) : (
        <Alert tone="success">Your {state.route === "PAN_ONLY" ? "PAN" : "GSTIN"} is verified: your shop goes live as soon as the payment is confirmed.</Alert>
      )}
      <WhatYouPay state={state} slab={slab} />
      <Button type="button" size="lg" className="w-full" disabled={busy || !docs.canSubmit} onClick={() => void send("/api/shops/registration-draft/submit")} data-testid="create-and-pay">
        {busy ? "Creating your shop…" : "Create my shop and pay"}
      </Button>
    </StepCard>
  );
}

/* --------------------------------------------------- 2. shop email (0120) */

function EmailStep({ state, busy, fields, send, back }: { state: WizardState; busy: boolean; fields: Record<string, string>; send: Send; back: ReactNode }) {
  const account = state.email.account;
  const [choice, setChoice] = useState<"account" | "other" | null>(state.email.shop && state.email.shop !== account ? "other" : account ? null : "other");
  const [email, setEmail] = useState(state.email.shop && state.email.shop !== account ? state.email.shop : "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setSending(true);
    setError(null);
    const response = await fetch("/api/shops/registration-draft/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setSending(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Could not send the code. Please try again.");
      return;
    }
    setSentTo(payload?.codeSent?.maskedEmail ?? email);
  }

  return (
    <StepCard title="2. Email for your shop" intro="Orders, payouts and GoKesari notices for your shop go to this email.">
      {account ? (
        <div className="grid gap-2" role="radiogroup" aria-label="Email for your shop">
          <button
            type="button"
            role="radio"
            aria-checked={choice === "account"}
            onClick={() => setChoice("account")}
            className={`rounded-xl border p-3 text-left ${choice === "account" ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`}
          >
            <span className="block text-sm font-semibold text-ink-900">Use {account}</span>
            <span className="block text-xs text-ink-600">The email you signed in with — nothing more to confirm.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={choice === "other"}
            onClick={() => setChoice("other")}
            className={`rounded-xl border p-3 text-left ${choice === "other" ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`}
          >
            <span className="block text-sm font-semibold text-ink-900">Use a different email for the shop</span>
            <span className="block text-xs text-ink-600">We&apos;ll email a code to confirm it.</span>
          </button>
        </div>
      ) : null}
      {choice === "account" ? (
        <Button type="button" size="lg" className="w-full" disabled={busy} onClick={() => void send("/api/shops/registration-draft/email", { useAccount: true })}>
          {busy ? "Saving…" : "Continue with this email"}
        </Button>
      ) : null}
      {choice === "other" ? (
        <div className="space-y-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label="Shop email" error={fields.email}>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSentTo(null);
              }}
              autoComplete="email"
              placeholder="shop@example.com"
              data-testid="wizard-shop-email"
            />
          </Field>
          {sentTo ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send("/api/shops/registration-draft/email", { email, code });
              }}
            >
              <p className="text-sm text-ink-700">
                We emailed a code to <strong>{sentTo}</strong>.
              </p>
              <Field label="Code from the email" error={fields.code}>
                <input
                  className={`${inputClass} font-mono text-lg tracking-[0.4em]`}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  data-testid="wizard-shop-email-code"
                />
              </Field>
              <Button type="submit" size="lg" className="w-full" disabled={busy || code.length < 4}>
                {busy ? "Checking…" : "Confirm email and continue"}
              </Button>
              <button type="button" className="text-sm text-kesari-700 underline" disabled={sending} onClick={() => void sendCode()}>
                Send the code again
              </button>
            </form>
          ) : (
            <Button type="button" size="lg" className="w-full" disabled={sending || !email.includes("@")} onClick={() => void sendCode()}>
              {sending ? "Sending…" : "Email me a code"}
            </Button>
          )}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">{back}</div>
    </StepCard>
  );
}

/**
 * "What you pay" before payment (onboarding Phase B, G11; owner 05-Nov-2026: the fee is yearly):
 * the fee and GST, that it renews, and what happens to payouts — no surprise after paying.
 */
function WhatYouPay({ state, slab }: { state: WizardState; slab: number | null }) {
  const rule = state.feeRule;
  const feePaise = slab ? rule.slabs[slab - 1]?.feePaise : null;
  return (
    <div className="rounded-xl border border-kesari-100 bg-kesari-50 p-3 text-sm text-ink-700" data-testid="what-you-pay">
      <p className="font-semibold text-ink-900">What you pay</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>
          Registration fee{feePaise != null ? <> {formatRupeesIndian(Math.round(feePaise / 100))} + GST</> : null} — covers {state.membershipMonths} months, then
          renews every year. You see the exact total, with any coupon, on the payment page.
        </li>
        <li>Commission on orders as in the Seller Terms — nothing is charged until you get orders.</li>
        <li>Payouts go to your bank account once it is added and verified (you add it after your shop is live).</li>
      </ul>
      <Link href="/legal/seller-terms" className="mt-1 inline-block font-medium text-kesari-800 underline">
        Seller Terms
      </Link>
    </div>
  );
}
