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
import { DocumentScan, type ScannedNumber } from "./document-scan";

/**
 * Shop onboarding wizard (docs/shop-onboarding-wizard-2026-10, BRIEF_REDESIGN.md,
 * FLOW_2026-10-30.md and FLOW_2026-10-30-b.md): one step at a time, shown as a Tile Board at the top —
 * referral code (enter or request) → shop email → documents now? Yes / No → the document window
 * (GSTIN, PAN, Shop Act, FSSAI, Udyam, each with Validate; or scanned) → confirm the shop and owner
 * name → payment → live → address and map pin → category → products.
 * "No" skips the document window: shop details → payment → live → address and map pin. Every answer from the server is the
 * whole wizard (services/shop-registration-wizard.ts), so the screen always
 * shows the step the server says comes next, and a returning owner resumes
 * where they left off. Numbers are shown masked; the server never sends them
 * back in full.
 */

type CheckStatus = "NOT_SUBMITTED" | "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED" | "MANUAL_REVIEW";
type Step = "REFERRAL" | "EMAIL" | "DOCS_READY" | "IDENTITY" | "UDYAM" | "FSSAI" | "DETAILS" | "REVIEW" | "PAYMENT" | "WAITING" | "LOCATION" | "CATEGORY" | "PRODUCTS" | "DONE";

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
  setup: { location: boolean; categories: boolean; products: boolean } | null;
  nextStep: Step;
}

/**
 * The registration's ten steps, always shown at the top of the page (Theme 1 Tile Board) — the one
 * checklist on the screen (owner brief 30 Oct 2026, FLOW_2026-10-30-b.md: the fee before the
 * address and map pin).
 */
const TILES = [
  { n: 1, label: "Referral", icon: "🎟️" },
  { n: 2, label: "Email", icon: "✉️" },
  { n: 3, label: "Documents", icon: "📂" },
  { n: 4, label: "Validate", icon: "🛡️" },
  { n: 5, label: "Confirm details", icon: "🏪" },
  { n: 6, label: "Payment", icon: "💳" },
  { n: 7, label: "Live", icon: "🚀" },
  { n: 8, label: "Address & location", icon: "📍" },
  { n: 9, label: "Category", icon: "🗂️" },
  { n: 10, label: "Products", icon: "📦" },
] as const;

/** The tile a wizard step belongs to. */
function tileOf(step: Step): number {
  switch (step) {
    case "REFERRAL":
      return 1;
    case "EMAIL":
      return 2;
    case "DOCS_READY":
      return 3;
    case "IDENTITY":
    case "UDYAM":
    case "FSSAI":
      return 4;
    case "DETAILS":
      return 5;
    case "REVIEW":
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
  const pastDocs = state.documentsLater === true || state.canContinue;
  if (open && n === 1) return "REFERRAL";
  if (open && n === 2 && state.referral.answered) return "EMAIL";
  if (open && n === 3 && state.email.confirmed) return "DOCS_READY";
  if (open && n === 4 && state.documentsLater === false) return "IDENTITY";
  if (open && n === 5 && pastDocs) return "DETAILS";
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
  // "Upload later": the verify tile is skipped (a food shop's FSSAI is still asked, on that tile).
  const later = state?.documentsLater === true;
  const at = later && step === "FSSAI" ? 4 : tileOf(step);
  const skipped = (n: number) => n === 4 && later && step !== "FSSAI";
  return (
    <ol className="grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Registration steps" data-testid="registration-tiles">
      {TILES.map((t) => {
        const done = t.n < at && !skipped(t.n);
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
            {skipped(t.n) ? <span className="block text-[0.625rem] leading-tight">after go-live</span> : null}
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
  // A check that let the owner go on but is not VERIFIED: its message stays on screen on the next step.
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const step: Step = viewing ?? state?.nextStep ?? "REFERRAL";
  // The latest wizard, for the scanned numbers' checks, which run one after another.
  const latest = useRef<WizardState | null>(initial);
  // Numbers read from the owner's photos (Udyam, FSSAI), filled into their steps.
  const [scanned, setScanned] = useState<Partial<Record<ScannedNumber["docType"], string>>>({});

  /** "Scan or upload a copy": the confirmed numbers checked online, the GSTIN (or PAN) first. */
  async function checkScanned(found: ScannedNumber[], consent: boolean, declaration: boolean) {
    const by: Partial<Record<ScannedNumber["docType"], string>> = Object.fromEntries(found.map((f) => [f.docType, f.number]));
    setScanned(by);
    const identity = by.GSTIN
      ? await send("/api/shops/registration-draft/gstin", { gstin: by.GSTIN, consent })
      : await send("/api/shops/registration-draft/pan", { pan: by.PAN, declaration, consent });
    if (!identity || !latest.current?.canContinue) return;
    for (const docType of ["UDYAM", "FSSAI"] as const) {
      const number = by[docType];
      if (number && !(await send("/api/shops/registration-draft/documents", { docType, number, consent }))) return;
    }
  }

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
    latest.current = result.data;
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

      {step === "REFERRAL" ? (
        <ReferralStep
          code={state?.referral.code ?? initialReferralCode ?? ""}
          required={state?.referral.required ?? referralRequired}
          busy={busy}
          fields={fields}
          send={send}
        />
      ) : null}
      {step === "EMAIL" && state ? <EmailStep state={state} busy={busy} fields={fields} send={send} back={back("REFERRAL")} /> : null}
      {step === "DOCS_READY" && state ? <DocumentsReadyStep busy={busy} send={send} back={back("EMAIL")} /> : null}
      {/* "Yes, I have them": every number on one window, each with its own Validate button. */}
      {step === "IDENTITY" || ((step === "UDYAM" || step === "FSSAI") && state && !state.documentsLater) ? (
        <IdentityStep
          state={state}
          busy={busy}
          fields={fields}
          send={send}
          stay={() => setViewing("IDENTITY")}
          done={() => setViewing(null)}
          back={back("DOCS_READY")}
          onScan={checkScanned}
        />
      ) : null}
      {step === "FSSAI" && state?.documentsLater ? (
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
          back={back(state.documentsLater ? "DETAILS" : "UDYAM")}
          scanned={scanned.FSSAI}
        />
      ) : null}
      {step === "DETAILS" && state ? (
        <DetailsStep state={state} busy={busy} fields={fields} send={send} dealerProgramme={dealerProgramme} back={back(state.documentsLater ? "DOCS_READY" : "FSSAI")} />
      ) : null}
      {step === "REVIEW" && state ? <ReviewStep state={state} busy={busy} send={send} goTo={setViewing} /> : null}
      {step === "PAYMENT" && state?.shop ? (
        <StepCard title="6. Pay the registration fee" intro="Pay by UPI or card. Your shop goes live as soon as the payment is confirmed. Next you give your shop's address and map location.">
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
        <Alert tone="success" title={`7. ${state.shop.name} is live`}>
          We&apos;ve emailed you that your registration succeeded{state.shop.registrationNumber ? ` (shop ID ${state.shop.registrationNumber})` : ""} and your shop is ready
          for product upload.{" "}
          {state.documentsLater ? (
            <strong>Payouts to your bank start once your GST or PAN is verified. </strong>
          ) : null}
          Upload {state.documentsLater ? "your GST certificate or PAN, the Shop Act" : "the Shop Act"} and other licences on{" "}
          <Link href="/shop/documents" className="underline">
            Documents
          </Link>{" "}
          — reminders are sent on the 1st and 15th of each month.
        </Alert>
      ) : null}
      {step === "LOCATION" && state?.shop ? (
        <ShopLocationStep
          title="8. Your shop's address and location"
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

/* ------------------------------------------------- 4. the document window */

type WindowDoc = "GSTIN" | "PAN" | "SHOP_ACT" | "FSSAI" | "UDYAM";

/**
 * Step 4 (owner brief 30 Oct 2026, FLOW_2026-10-30-b.md): every number on one window, in the
 * brief's order — GSTIN, PAN, Shop Act, FSSAI (optional), then Udyam (optional; owner's answer
 * "keep both") — each with its own Validate button that checks it with the government record
 * and shows the result on its line. A verified GSTIN fills the PAN, the shop name and the owner
 * name (shown on step 5). The owner goes on once the GSTIN, or the PAN without one, is not
 * refused; a line left empty is "not now" (Shop Act after go-live; FSSAI still required for a
 * food shop). "Scan or upload" reads the numbers from photos instead.
 */
function IdentityStep({
  state,
  busy,
  fields,
  send,
  stay,
  done,
  back,
  onScan,
}: {
  state: WizardState | null;
  busy: boolean;
  fields: Record<string, string>;
  send: Send;
  /** Keeps the window open after a check (the server would move on to the next step). */
  stay: () => void;
  /** Leaves the window for the step the server says is next. */
  done: () => void;
  back: ReactNode;
  onScan: (found: ScannedNumber[], consent: boolean, declaration: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<"type" | "scan">("type");
  const [numbers, setNumbers] = useState<Record<WindowDoc, string>>({ GSTIN: "", PAN: "", SHOP_ACT: "", FSSAI: "", UDYAM: "" });
  const [consent, setConsent] = useState(false);
  const [declaration, setDeclaration] = useState(state?.noGstDeclared ?? false);
  const [checking, setChecking] = useState<WindowDoc | null>(null);
  const [lastError, setLastError] = useState<WindowDoc | null>(null);
  // The PAN came with a verified GSTIN: no PAN of its own to type.
  const panFromGst = state?.route === "GSTIN" && state.gstin?.status === "VERIFIED";
  const fssaiRequired = state?.fssai.required ?? false;

  async function validate(doc: WindowDoc) {
    setChecking(doc);
    const number = numbers[doc].trim();
    const ok =
      doc === "GSTIN"
        ? await send("/api/shops/registration-draft/gstin", { gstin: number, consent })
        : doc === "PAN"
          ? await send("/api/shops/registration-draft/pan", { pan: number, declaration, consent })
          : await send("/api/shops/registration-draft/documents", { docType: doc, number, consent });
    setChecking(null);
    setLastError(ok ? null : doc);
    stay();
  }

  /** Continue: a line left empty is "not now" — then on to the step the server gives. */
  async function next() {
    if (!state) return;
    const later: ("SHOP_ACT" | "FSSAI" | "UDYAM")[] = [];
    if (!state.shopAct.done) later.push("SHOP_ACT");
    if (!state.fssai.done && !fssaiRequired) later.push("FSSAI");
    if (!state.udyam.done) later.push("UDYAM");
    for (const docType of later) {
      if (!(await send("/api/shops/registration-draft/documents", { docType, has: false }))) {
        stay();
        return;
      }
    }
    done();
  }

  const lines: { doc: WindowDoc; label: string; placeholder: string; note: string; check: CheckView | null; tag: string }[] = [
    { doc: "GSTIN", label: "GST number (GSTIN)", placeholder: "27ABCDE1234F1Z5", note: "Fills your PAN, shop name, owner name and address.", check: state?.gstin ?? null, tag: "GSTIN or PAN needed" },
    {
      doc: "PAN",
      label: "PAN",
      placeholder: "ABCDE1234F",
      note: panFromGst ? "Taken from your GST record." : "If your shop has no GST registration: fills your name from the Income Tax record.",
      check: state?.pan ?? null,
      tag: "GSTIN or PAN needed",
    },
    { doc: "SHOP_ACT", label: "Shop Act licence (Gumasta) number", placeholder: "Shop Act number", note: "Validate it now, or upload it after your shop is live.", check: state?.shopAct.check ?? null, tag: "Optional now" },
    {
      doc: "FSSAI",
      label: "FSSAI licence or registration",
      placeholder: "14-digit FSSAI number",
      note: fssaiRequired ? "Your shop type sells food, so FSSAI is required." : "Needed for shops that sell food.",
      check: state?.fssai.check ?? null,
      tag: fssaiRequired ? "Required" : "Optional",
    },
    { doc: "UDYAM", label: "Udyam (MSME) registration", placeholder: "UDYAM-MH-26-0012345", note: "If you have one.", check: state?.udyam.check ?? null, tag: "Optional" },
  ];

  const canContinue = Boolean(state?.canContinue) && (!fssaiRequired || Boolean(state?.fssai.done));

  return (
    <StepCard
      title={mode === "scan" ? "4. Scan or upload your documents" : "4. Enter and validate your documents"}
      intro={
        mode === "scan"
          ? "We read the numbers from your photos on your phone, you check them, then we verify them with the government records and fill in your details."
          : "Type each number and press Validate — we check it with the government record. A GST number or a PAN is needed; the rest can be added after your shop is live."
      }
    >
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-cream-100 p-1" role="tablist" aria-label="How to give your documents">
        {(
          [
            ["type", "⌨️ Type the numbers"],
            ["scan", "📷 Scan or upload"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`min-h-11 rounded-lg px-2 text-sm font-semibold ${mode === key ? "bg-white text-ink-900 shadow-sm" : "text-ink-600"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "scan" ? (
        <DocumentScan
          busy={busy}
          onConfirm={(found) => void onScan(found, consent, declaration)}
          extra={(found) => {
            const gst = found.some((f) => f.docType === "GSTIN");
            const pan = found.some((f) => f.docType === "PAN");
            if (!gst && !pan) {
              return { node: <Alert tone="warning">Add a photo of your GST certificate or PAN card — one of them is needed to verify your shop.</Alert>, ok: false };
            }
            return {
              node: (
                <div className="space-y-2">
                  {!gst ? <Consent checked={declaration} onChange={setDeclaration} text={GST_DECLARATION_TEXT} /> : null}
                  <Consent checked={consent} onChange={setConsent} />
                </div>
              ),
              ok: consent && (gst || declaration),
            };
          }}
        />
      ) : (
        <>
          <Consent checked={consent} onChange={setConsent} />
          <ol className="space-y-3" data-testid="document-window">
            {lines.map((line, i) => {
              const verified = line.check?.status === "VERIFIED";
              const fromGst = line.doc === "PAN" && panFromGst;
              const needsDeclaration = line.doc === "PAN" && !panFromGst;
              // The no-GST declaration appears once a PAN is typed (or one was declared before).
              const showDeclaration = needsDeclaration && (numbers.PAN.trim() !== "" || declaration);
              const blocked = busy || !consent || !numbers[line.doc].trim() || (needsDeclaration && !declaration);
              return (
                <li key={line.doc} className="rounded-xl border border-[var(--gk-line)] bg-white p-3" data-testid={`doc-line-${line.doc}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-900">
                      {i + 1}. {line.label}
                    </p>
                    <Badge tone={line.tag === "Required" ? "danger" : line.tag === "GSTIN or PAN needed" ? "warning" : "neutral"}>{line.tag}</Badge>
                  </div>
                  <p className="text-xs text-ink-600">{line.note}</p>
                  {fromGst ? null : (
                    <div className="mt-2 flex gap-2">
                      <div className="min-w-0 flex-1">
                        <input
                          aria-label={line.label}
                          className={`${inputClass} font-mono uppercase`}
                          value={numbers[line.doc]}
                          onChange={(e) => setNumbers({ ...numbers, [line.doc]: e.target.value })}
                          autoCapitalize="characters"
                          autoComplete="off"
                          placeholder={verified ? `${line.check?.numberMasked ?? ""} — validated` : line.placeholder}
                          maxLength={40}
                        />
                        {lastError === line.doc && (fields.gstin ?? fields.pan ?? fields.number) ? (
                          <span className="mt-1 block text-xs text-red-600">{fields.gstin ?? fields.pan ?? fields.number}</span>
                        ) : null}
                      </div>
                      <Button type="button" className="shrink-0" disabled={blocked} onClick={() => void validate(line.doc)} data-testid={`validate-${line.doc}`}>
                        {checking === line.doc ? "Checking…" : "Validate"}
                      </Button>
                    </div>
                  )}
                  {showDeclaration ? (
                    <div className="mt-2">
                      <Consent checked={declaration} onChange={setDeclaration} text={GST_DECLARATION_TEXT} />
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <StatusLine check={line.check} />
                  </div>
                </li>
              );
            })}
          </ol>
          {!consent ? <p className="text-xs text-ink-600">Tick the consent above to validate a number.</p> : null}
        </>
      )}
      {!canContinue && state?.canContinue ? <Alert tone="warning">Validate your FSSAI number to continue — it is required for a shop that sells food.</Alert> : null}
      <div className="flex items-center justify-between gap-2">
        {back}
        <Button type="button" size="lg" disabled={busy || !canContinue} onClick={() => void next()} data-testid="documents-continue">
          {busy && checking === null ? "Saving…" : "Continue"}
        </Button>
      </div>
      {!state?.canContinue ? (
        <p className="text-xs text-ink-600">
          No GST number or PAN at hand? Go back and choose <strong>No</strong> — you can register now and add your documents after your shop is live.
        </p>
      ) : null}
    </StepCard>
  );
}

/** What the GST / PAN record filled in (the retrieved shop and owner name), shown on step 5 to confirm. */
function PrefillSummary({ state }: { state: WizardState }) {
  const p = state.prefill;
  const missing = "Not in the record — please fill it in below";
  const rows = [
    ["Shop name", p.shopName ?? p.tradeName ?? p.legalName ?? missing],
    // A company's or firm's GST record names no single owner.
    ["Owner name", p.ownerName ?? missing],
    ["Legal name", p.legalName],
    ["Registered address", p.address],
    ["PAN", state.pan?.numberMasked ?? null],
  ].filter((r): r is [string, string] => Boolean(r[1]));
  if (!state.gstin && !state.pan) return null;
  return (
    <div className="rounded-lg border border-leaf-300 bg-leaf-50 p-3 text-sm" data-testid="prefill-summary">
      <p className="font-semibold text-leaf-700">✓ Retrieved from your {state.route === "PAN_ONLY" ? "PAN" : "GST"} record — check them; you can edit them below</p>
      <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <dt className="text-ink-500">{k}:</dt>
            <dd className={v === missing ? "text-kesari-800" : k === "Shop name" || k === "Owner name" ? "font-semibold text-ink-900" : "text-ink-900"}>{v}</dd>
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
    shopType: d?.shopType ?? "",
    addressLine1: d?.addressLine1 ?? p.address ?? "",
    addressLine2: d?.addressLine2 ?? "",
    area: d?.area ?? "",
    city: d?.city ?? "",
    state: d?.state ?? "",
    pincode: d?.pincode ?? p.pincode ?? "",
    landmark: d?.landmark ?? "",
    couponCode: d?.couponCode ?? "",
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
      // The shop's email and the referral code come from steps 1 and 2.
      email: null,
      shopType: form.shopType,
      categoryIds: d?.categoryIds ?? [],
      annualTurnoverRupees: rule.enabled && slab ? turnoverFor(slab) : null,
      couponCode: blank(form.couponCode),
      referralCode: null,
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
      title="5. Confirm your shop details"
      intro={
        state.documentsLater
          ? "Tell us about your shop. You'll add your documents after your shop is live."
          : p.legalName
            ? `From the government record: ${p.legalName}${p.constitution ? ` (${p.constitution})` : ""}. Check the shop and owner name, edit them if needed, and pick your turnover slab.`
            : "Check your shop details and pick your turnover slab."
      }
    >
      {state.documentsLater ? null : <PrefillSummary state={state} />}
      {state.email.shop ? (
        <p className="text-sm text-ink-600">
          Shop email: <strong className="text-ink-900">{state.email.shop}</strong>
        </p>
      ) : null}
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
          <Field label="Shop type" error={fields.shopType} hint="Food shops need an FSSAI licence — we'll ask for it next.">
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
          <summary className="cursor-pointer font-medium">More (address line 2, area, landmark)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
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
                    <span className="block text-sm text-ink-700">Fee {formatRupeesIndian(Math.round(s.feePaise / 100))} + GST</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <Field label="Coupon code (optional)" error={fields.couponCode}>
          <input className={`${inputClass} uppercase`} value={form.couponCode} onChange={set("couponCode")} maxLength={40} />
        </Field>
        {dealerProgramme ? (
          <Field label="GoKesari employee who helped you (optional)">
            <input className={inputClass} value={form.employeeId} onChange={set("employeeId")} maxLength={120} />
          </Field>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {back}
          <Button type="submit" size="lg" disabled={busy || (rule.enabled && slab === null)}>
            {busy ? "Saving…" : "Confirm and continue to payment"}
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
  /** Udyam, right after the GST / PAN step: what the record filled in. */
  prefill?: WizardState;
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
    <StepCard title="6. Check your fee and pay" intro="Your shop is created when you continue; then you pay the one-time registration fee by UPI or card. After payment you confirm the address and place your shop on the map.">
      <div>
        {row("Referral code", state.referral.code ?? "None", "REFERRAL")}
        {row("Shop email", state.email.shop ?? "—", "EMAIL")}
        {state.documentsLater ? (
          <>
            {row("Documents", "You'll upload them after your shop is live", "DOCS_READY")}
            {state.foodShop ? row("FSSAI", doc(state.fssai.check, "—"), "FSSAI") : null}
          </>
        ) : (
          <>
            {row(state.route === "PAN_ONLY" ? "PAN (no GST)" : "GSTIN", doc(state.route === "PAN_ONLY" ? state.pan : state.gstin, "—"), "IDENTITY")}
            {row("Shop Act", state.shopAct.has === false ? "After go-live" : doc(state.shopAct.check, "—"), "IDENTITY")}
            {row("FSSAI", state.fssai.has === false ? "No licence" : doc(state.fssai.check, "—"), "IDENTITY")}
            {row("Udyam", state.udyam.has === false ? "Not registered" : doc(state.udyam.check, "—"), "IDENTITY")}
          </>
        )}
        {row("Shop", `${d.name} · ${d.addressLine1}, ${d.city} ${d.pincode}`, "DETAILS")}
        {slab ? row("Turnover slab", `${turnoverSlabLabel(slab, rule)} — fee ${formatRupeesIndian(Math.round(rule.slabs[slab - 1].feePaise / 100))} + GST`, "DETAILS") : null}
      </div>
      {!docs.canSubmit ? (
        <Alert tone="warning" title="Your GST or PAN is not verified">
          Go back to step 4 and validate your {state.route === "PAN_ONLY" ? "PAN" : "GSTIN"} again, or choose to upload your documents later on step 3.
        </Alert>
      ) : docs.needsTeamApproval ? (
        <Alert tone="info">{`After payment your shop waits for admin approval: ${names(docs.missing)} is not verified yet.`}</Alert>
      ) : state.documentsLater ? (
        <Alert tone="info" title="Your shop goes live as soon as the payment is confirmed">
          Payouts to your bank start once your GST or PAN is verified. Upload your documents on Documents after go-live — we remind you on the 1st and 15th, and a
          shop without them is paused after the third reminder.
        </Alert>
      ) : (
        <Alert tone="success">Your documents are verified: your shop goes live as soon as the payment is confirmed.</Alert>
      )}
      <Button type="button" size="lg" className="w-full" disabled={busy || !docs.canSubmit} onClick={() => void send("/api/shops/registration-draft/submit")}>
        {busy ? "Creating your shop…" : "Create my shop and pay"}
      </Button>
    </StepCard>
  );
}

/* ------------------------------------------------- 1. referral code (0120) */

/** The documents the owner should have, listed under the referral options (owner brief 30 Oct 2026). */
const REQUIRED_DOCUMENTS: { icon: string; name: string; note: string; tag: string; tone: "danger" | "warning" | "neutral" }[] = [
  { icon: "🧾", name: "GST certificate (GSTIN)", note: "or your PAN card if the shop is not GST-registered", tag: "Needed", tone: "danger" },
  { icon: "🪪", name: "PAN card", note: "filled in from your GST record when you have GST", tag: "Needed without GST", tone: "danger" },
  { icon: "🏪", name: "Shop Act licence (Gumasta)", note: "validate it now, or upload it after your shop is live", tag: "Now or later", tone: "neutral" },
  { icon: "🥛", name: "FSSAI licence or registration", note: "for shops that sell food — dairy, bakery, sweets, grocery, restaurants", tag: "Food shops", tone: "warning" },
  { icon: "🏭", name: "Udyam (MSME) registration", note: "if you have one", tag: "Optional", tone: "neutral" },
  { icon: "🏦", name: "Bank account for payouts", note: "added in Seller Central after go-live", tag: "After go-live", tone: "neutral" },
];

function RequiredDocuments() {
  return (
    <section aria-labelledby="required-documents" className="space-y-2">
      <h3 id="required-documents" className="text-sm font-semibold text-ink-900">
        Documents to keep ready
      </h3>
      <ul className="divide-y divide-cream-100 rounded-xl border border-[var(--gk-line)] bg-white" data-testid="documents-list">
        {REQUIRED_DOCUMENTS.map((d) => (
          <li key={d.name} className="flex items-start gap-3 p-3">
            <span className="text-xl leading-none" aria-hidden>
              {d.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink-900">{d.name}</span>
              <span className="block text-xs text-ink-600">{d.note}</span>
            </span>
            <Badge tone={d.tone}>{d.tag}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Step 1 (owner brief 30 Oct 2026): two options side by side — "Enter Referral Code" and
 * "Request Referral Code" — then the list of documents the owner needs. The tile board above is
 * the screen's only checklist.
 */
function ReferralStep({ code: initialCode, required, busy, fields, send }: { code: string; required: boolean; busy: boolean; fields: Record<string, string>; send: Send }) {
  const [code, setCode] = useState(initialCode);
  const [requesting, setRequesting] = useState(false);
  return (
    <StepCard
      title="1. Your referral code"
      intro={required ? "A referral code from a GoKesari distributor is needed to register." : "Got a code from a GoKesari distributor? Enter it. You can also register without one."}
    >
      {requesting ? <ReferralRequestDialog prefill={{}} onClose={() => setRequesting(false)} /> : null}
      <div className="grid gap-3 sm:grid-cols-2" data-testid="referral-options">
        <form
          className="space-y-3 rounded-xl border border-kesari-300 bg-white p-3"
          aria-labelledby="referral-enter"
          onSubmit={(e) => {
            e.preventDefault();
            void send("/api/shops/registration-draft/referral", { referralCode: code.trim() || null });
          }}
        >
          <h3 id="referral-enter" className="text-sm font-semibold text-ink-900">
            Enter Referral Code
          </h3>
          <Field label={required ? "Referral code" : "Referral code (optional)"} error={fields.referralCode}>
            <input
              className={`${inputClass} font-mono text-base uppercase tracking-widest`}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="AB12CD34"
              maxLength={32}
              required={required}
              data-testid="wizard-referral-code"
            />
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={busy || (required && code.trim().length < 3)}>
            {busy ? "Checking…" : code.trim() ? "Check code and continue" : required ? "Enter your code to continue" : "Continue without a code"}
          </Button>
        </form>
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--gk-line)] bg-white p-3" aria-labelledby="referral-request">
          <h3 id="referral-request" className="text-sm font-semibold text-ink-900">
            Request Referral Code
          </h3>
          <p className="flex-1 text-sm text-ink-600">No code yet? Send us your shop&apos;s name, mobile and area — a GoKesari distributor near you gets in touch with a code.</p>
          <Button type="button" size="lg" variant="secondary" className="w-full" onClick={() => setRequesting(true)}>
            Request Referral Code
          </Button>
        </div>
      </div>
      <RequiredDocuments />
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

/* -------------------------------------------- 3. documents handy? (0120) */

/**
 * Step 3: the Yes / No question. Yes → the document window (step 4); No → "upload later": shop
 * details, the fee, and the documents after go-live.
 */
function DocumentsReadyStep({ busy, send, back }: { busy: boolean; send: Send; back: ReactNode }) {
  return (
    <StepCard title="3. Do you have your documents now?" intro="Your GST number or PAN, and the Shop Act, FSSAI and Udyam numbers if you have them — typed, or read from photos.">
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Do you have your documents now?" data-testid="documents-yes-no">
        <Button type="button" size="lg" disabled={busy} onClick={() => void send("/api/shops/registration-draft/documents-ready", { later: false })}>
          Yes
        </Button>
        <Button type="button" size="lg" variant="secondary" disabled={busy} onClick={() => void send("/api/shops/registration-draft/documents-ready", { later: true })}>
          No
        </Button>
      </div>
      <ul className="space-y-1 text-xs text-ink-600">
        <li>
          <strong>Yes:</strong> enter each number and validate it with the government record; your shop and owner name are filled in for you.
        </li>
        <li>
          <strong>No — add them later:</strong> give your shop details, pay the fee, and your shop goes live. Payouts start once your GST or PAN is verified; we remind you
          on the 1st and 15th, and a shop without documents is paused after the third reminder.
        </li>
      </ul>
      <div className="flex items-center justify-between gap-2">{back}</div>
    </StepCard>
  );
}
