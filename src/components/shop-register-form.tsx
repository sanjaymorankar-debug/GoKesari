"use client";

import Link from "next/link";

import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { formatPaiseCompact, rupeesToPaise } from "@/lib/money";
import { RegistrationFeeSummary, type AppliedCoupon } from "@/components/registration-fee-summary";
import {
  feeForTurnover,
  turnoverSlab,
  turnoverSlabLabel,
  formatRupeesIndian,
  parseTurnoverRupees,
  type TurnoverFeeRule,
} from "@/lib/registration-fee";
import {
  IDENTIFIER_REQUIRED_MESSAGE,
  parseGstin,
  parsePanNumber,
  parseShopActNumber,
  parseUdyamNumber,
  type ParseResult,
  type ShopIdentifierField,
} from "@/lib/shop-identity";
import { isProfessionalShopType } from "@/lib/shop-types";
import { useShopTypes } from "@/components/use-shop-types";
import { ReferralRequestDialog, type ReferralRequestPrefill } from "@/components/referral-request-dialog";

/**
 * Shop registration (§8).
 *
 * Note what is NOT on this form: status and Kesari/Green classification. Both
 * are assigned server-side by an operator, so a shop cannot self-approve or
 * self-classify.
 *
 * Duplicate registrations are refused by the server (services/shop-duplicates.ts).
 * This form only surfaces that early — a pre-check when the owner leaves an
 * identifier or PIN code field — and makes sure one registration is sent
 * once, however many times Submit is clicked.
 *
 * One registration under review per owner (owner request, 26 Oct 2026): with
 * one already waiting (`pending`), every field and Submit stay off and the page
 * points at its fee payment instead. The server refuses it too (registerShop).
 *
 * The one-time registration fee follows the declared annual turnover
 * (src/lib/registration-fee.ts) and is shown before Submit; the server computes
 * it again. After Submit the owner goes to the fee payment page.
 */

/** Category groups to list first in the picker for each professional shop type. */
const CATEGORY_GROUPS_FOR: Record<string, readonly string[]> = {
  PROFESSIONAL_OFFICE: ["Finance and legal"],
  DOCTOR_CLINIC: ["Medical — doctors and clinics"],
  SUPER_SPECIALITY_CLINIC: ["Medical — doctors and clinics"],
  CONSULTANT: ["Consulting and services"],
};

/** Fields the duplicate pre-check runs on when the owner leaves them. */
type CheckedField = ShopIdentifierField | "pincode";

interface Notice {
  tone: "warning" | "info";
  message: string;
}

/** What the last pre-check of one field found. */
interface CheckResult {
  /** The field to highlight (not always the one checked), and the line under it. */
  field?: string;
  fieldMessage?: string;
  notice?: Notice;
}

const FORMAT_CHECKS: Record<ShopIdentifierField, (raw: string) => ParseResult<unknown>> = {
  shopActNumber: parseShopActNumber,
  panNumber: parsePanNumber,
  udyamNumber: parseUdyamNumber,
};

export function ShopRegisterForm({
  referralRequired = false,
  feeRule = null,
  feeQuote = null,
  pending = null,
  initialCategories,
}: {
  /** Admin setting referral_required_shop is MANDATORY (docs/nearby-referral-2026-10). Otherwise the field is optional. */
  referralRequired?: boolean;
  /** Rule registrationFeeByTurnover; null or disabled → no turnover question. */
  feeRule?: TurnoverFeeRule | null;
  /** The base fee (Admin → Registration fee) and the GST rate on it, read by the server page. */
  feeQuote?: { basePaise: number; gstRateBp: number } | null;
  /** The owner's registration already waiting for approval: the form stays off. */
  pending?: { id: string; name: string; feeDue: boolean } | null;
  /** Active shop categories, read by the server page. */
  initialCategories?: PickerCategory[];
} = {}) {
  const shopTypes = useShopTypes();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  // Set synchronously on the first submit, before React has re-rendered the
  // button as disabled — a double-click can never send two registrations.
  const submittingRef = useRef(false);
  // Latest pre-check per field; a slower, older answer is dropped.
  const checkSeq = useRef<Partial<Record<CheckedField, number>>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"danger" | "warning">("danger");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Partial<Record<CheckedField, CheckResult>>>({});
  const [panEntered, setPanEntered] = useState(false);
  const [deliveryAvailable, setDeliveryAvailable] = useState(false);
  const [shopType, setShopType] = useState("");
  const [turnover, setTurnover] = useState("");
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  const professional = isProfessionalShopType(shopType);
  const askTurnover = feeRule?.enabled === true;
  const turnoverRupees = parseTurnoverRupees(turnover);
  const feePreview = askTurnover && feeRule && turnoverRupees !== null ? feeForTurnover(turnoverRupees, feeRule) : null;
  // The base fee before coupon and GST: by turnover while that rule is on, else the flat fee.
  const feeBasePaise = askTurnover ? feePreview : (feeQuote?.basePaise ?? null);
  const locked = pending !== null;
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  // Referral code (feature 4): checked as the owner leaves the field; the server checks again.
  const [referralCode, setReferralCode] = useState("");
  const [referralCheck, setReferralCheck] = useState<{ valid: boolean; message: string | null } | null>(null);
  const [requestPrefill, setRequestPrefill] = useState<ReferralRequestPrefill | null>(null);

  async function checkReferral() {
    const code = referralCode.trim();
    if (!code) return setReferralCheck(null);
    const response = await fetch(`/api/referral-codes/check?code=${encodeURIComponent(code)}`).catch(() => null);
    const payload = response?.ok ? await response.json().catch(() => null) : null;
    setReferralCheck(payload ? { valid: payload.valid, message: payload.message } : null);
  }

  function openReferralRequest() {
    const data = formRef.current ? new FormData(formRef.current) : null;
    const value = (key: string) => String(data?.get(key) ?? "").trim();
    setRequestPrefill({
      name: value("ownerName"),
      mobile: value("phone"),
      shopType: value("shopType"),
      area: value("area"),
      city: value("city"),
      pincode: value("pincode"),
    });
  }

  function handleMapConfirm(result: MapPickerResult) {
    setCoordinates({ latitude: result.latitude, longitude: result.longitude });
  }

  function setCheck(field: CheckedField, result: CheckResult | null) {
    setChecks((prev) => {
      if (result) return { ...prev, [field]: result };
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  /**
   * Duplicate pre-check for one field. Advisory only: a failed or
   * rate-limited check never blocks the form — the server checks again, under
   * a lock, when the form is submitted.
   */
  async function precheck(field: CheckedField) {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? "").trim();

    const seq = (checkSeq.current[field] ?? 0) + 1;
    checkSeq.current[field] = seq;

    const raw = value(field);
    if (field === "pincode") {
      // Only the same-name-and-PIN rule can match, and it needs both.
      if (!/^\d{6}$/.test(raw) || !value("name")) return setCheck(field, null);
    } else {
      if (!raw) return setCheck(field, null);
      const format = FORMAT_CHECKS[field](raw);
      if (!format.ok) return setCheck(field, { field, fieldMessage: format.error });
    }

    const response = await fetch("/api/shops/duplicate-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(field === "pincode" ? {} : { [field]: raw }),
        name: value("name") || null,
        addressLine1: value("addressLine1") || null,
        pincode: value("pincode") || null,
      }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (checkSeq.current[field] !== seq) return;

    if (!response?.ok) {
      const fieldError = payload?.error?.details?.fields?.[field];
      setCheck(field, typeof fieldError === "string" ? { field, fieldMessage: fieldError } : null);
    } else if (payload?.status === "DUPLICATE") {
      setCheck(field, {
        field: payload.field,
        fieldMessage: payload.fieldMessage,
        notice: { tone: "warning", message: payload.message },
      });
    } else if (payload?.status === "RESUBMISSION") {
      setCheck(field, { notice: { tone: "info", message: payload.message } });
    } else {
      setCheck(field, null);
    }
  }

  /** Sends the registration; true once it is accepted. */
  async function submit(formData: FormData): Promise<boolean> {
    setError(null);
    setFieldErrors({});
    setChecks({});

    const get = (key: string) => String(formData.get(key) ?? "").trim();
    const deliveryFee = get("deliveryFee");

    // The same rules the server applies (api/shops/route.ts), checked here
    // first so every mistake is shown at once, next to its field.
    const invalid: Record<string, string> = {};
    if (!get("name")) invalid.name = "Shop name is required.";
    if (!get("ownerName")) invalid.ownerName = "Shop owner name is required.";
    if (askTurnover && turnoverRupees === null) {
      invalid.annualTurnover = turnover.trim()
        ? "Enter the annual turnover in whole rupees, e.g. 1500000."
        : "Enter your annual turnover — it sets the registration fee.";
    }
    if (!get("shopActNumber") && !get("panNumber") && !get("udyamNumber") && !get("gstin")) {
      invalid.identifiers = IDENTIFIER_REQUIRED_MESSAGE;
    }
    if (referralRequired && !referralCode.trim()) {
      invalid.referralCode = "A referral code is required to register a shop — request one if you don't have it.";
    } else if (referralCode.trim() && referralCheck?.valid === false) {
      invalid.referralCode = referralCheck.message ?? "This referral code is not valid.";
    }
    for (const field of Object.keys(FORMAT_CHECKS) as ShopIdentifierField[]) {
      if (!get(field)) continue;
      const format = FORMAT_CHECKS[field](get(field));
      if (!format.ok) invalid[field] = format.error;
    }
    if (get("gstin")) {
      const gst = parseGstin(get("gstin"));
      if (!gst.ok) invalid.gstin = gst.error;
    }
    if (Object.keys(invalid).length > 0) {
      setErrorTone("danger");
      setError("Please check the highlighted fields.");
      setFieldErrors(invalid);
      return false;
    }

    if (categoryIds.length === 0) {
      setErrorTone("danger");
      setError("Please select at least one shop category.");
      setFieldErrors({ categoryIds: "Please select at least one shop category." });
      return false;
    }

    let response: Response;
    try {
      response = await fetch("/api/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: get("name"),
          ownerName: get("ownerName"),
          phone: get("phone"),
          email: get("email") || null,
          addressLine1: get("addressLine1"),
          addressLine2: get("addressLine2") || null,
          area: get("area") || null,
          city: get("city"),
          state: get("state") || null,
          pincode: get("pincode"),
          latitude: coordinates ? String(coordinates.latitude) : null,
          longitude: coordinates ? String(coordinates.longitude) : null,
          landmark: get("landmark") || null,
          shopType: get("shopType"),
          categoryIds,
          description: get("description") || null,
          annualTurnoverRupees: askTurnover ? turnoverRupees : null,
          couponCode: coupon?.code ?? null,
          shopActNumber: get("shopActNumber") || null,
          panNumber: get("panNumber") || null,
          panHolderName: get("panHolderName") || null,
          udyamNumber: get("udyamNumber") || null,
          gstin: get("gstin") || null,
          // docs/nearby-referral-2026-10: sent whenever entered — an optional code must still be valid.
          referralCode: referralCode.trim() || null,
          // A practice or office offers services: nothing to deliver.
          deliveryAvailable: deliveryAvailable && !professional,
          deliveryFeePaise:
            deliveryAvailable && !professional && deliveryFee ? rupeesToPaise(Number(deliveryFee)) : 0,
          // Sensible default hours; the owner can refine them later.
          openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
            day,
            open: "06:00",
            close: "22:00",
          })),
        }),
      });
    } catch {
      setErrorTone("danger");
      setError("Could not reach the server. Check your connection and try again.");
      return false;
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const fields = payload?.error?.details?.fields;
      if (fields && typeof fields === "object") setFieldErrors(fields);
      // "Already registered" / "already waiting" is not a mistake in what the owner typed.
      const reason = payload?.error?.details?.reason;
      setErrorTone(reason === "DUPLICATE_SHOP" || reason === "REGISTRATION_PENDING" ? "warning" : "danger");
      setError(payload?.error?.message ?? "Could not register the shop.");
      return false;
    }
    // Next step: pay the one-time registration fee, then upload the mandatory
    // documents (docs/document-upload-2026-10) — the fee page links on to them.
    const id = typeof payload?.id === "string" ? payload.id : null;
    const feeDue = (payload?.registrationFeePaise ?? 0) > (payload?.amountPaidPaise ?? 0) && payload?.feePaymentStatus !== "PAID";
    router.push(
      id && feeDue ? `/shop/registration-fee?shop=${id}` : id ? `/shop/documents?shop=${id}` : "/shop/documents",
    );
    router.refresh();
    return true;
  }

  // A submit handler rather than a form `action`: React 19 resets a form
  // once its action finishes — wiping everything the owner typed whenever the
  // server says no — and state set inside an action doesn't render until the
  // action ends, so the button would not show as busy while it runs.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);

    const accepted = await submit(new FormData(event.currentTarget));
    // On success both stay set: the page is navigating away.
    if (!accepted) {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const checkResults = Object.values(checks).filter((c): c is CheckResult => c !== undefined);
  const errorFor = (name: string) =>
    checkResults.find((c) => c.field === name)?.fieldMessage ?? fieldErrors[name];
  // One notice per distinct message: the PAN and PIN checks can report the same match.
  const shownNotices = [
    ...new Map(
      checkResults.flatMap((c) => (c.notice ? [[c.notice.message, c.notice] as const] : [])),
    ).values(),
  ];

  return (
    <Card className="p-6">
      {requestPrefill ? <ReferralRequestDialog prefill={requestPrefill} onClose={() => setRequestPrefill(null)} /> : null}
      {pending ? (
        <div className="mb-4" data-testid="registration-locked">
          <Alert tone="warning" title="Submit is off while your registration is under review">
            {pending.feeDue ? (
              <>
                <Link href={`/shop/registration-fee?shop=${pending.id}`} className="font-semibold underline">
                  Pay the registration fee for {pending.name}
                </Link>{" "}
                so the review can go ahead.
              </>
            ) : (
              <>{pending.name} has been sent for review — nothing more to do for now.</>
            )}
          </Alert>
        </div>
      ) : null}
      <form ref={formRef} onSubmit={handleSubmit}>
        {/* disabled: every field is off while a registration waits (pending). */}
        <fieldset disabled={locked} className="grid min-w-0 gap-4 sm:grid-cols-2 disabled:opacity-60">
        <div className="sm:col-span-2">
          <Field label="Shop name *" error={errorFor("name")}>
            <input name="name" required className={inputClass} />
          </Field>
        </div>

        <Field label="Owner name *" error={errorFor("ownerName")}>
          <input name="ownerName" required className={inputClass} />
        </Field>

        <Field
          label="Phone"
          hint="10-digit Indian mobile number"
          error={errorFor("phone")}
        >
          <input
            name="phone"
            required
            inputMode="numeric"
            pattern="[6-9][0-9]{9}"
            className={inputClass}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Email (optional)" error={errorFor("email")}>
            <input name="email" type="email" className={inputClass} />
          </Field>
        </div>

        {/* Always shown (docs/nearby-referral-2026-10): required or "(optional)" by the admin's setting. */}
        <div className="sm:col-span-2" data-testid="referral-code-field">
          <Field
            label={referralRequired ? "Referral code *" : "Referral code (optional)"}
            hint={referralCheck?.valid ? "Referral code accepted." : "Given to you by a GoKesari partner or our team."}
            error={errorFor("referralCode") ?? (referralCheck?.valid === false ? (referralCheck.message ?? "This referral code is not valid.") : undefined)}
          >
            <div className="flex flex-wrap gap-2">
              <input
                name="referralCode"
                value={referralCode}
                onChange={(e) => {
                  setReferralCode(e.target.value.toUpperCase());
                  setReferralCheck(null);
                  // A corrected code must not keep showing the last submit's error.
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.referralCode;
                    return next;
                  });
                }}
                onBlur={() => void checkReferral()}
                autoComplete="off"
                maxLength={32}
                className={`${inputClass} min-w-0 flex-1 uppercase`}
                aria-label="Referral code"
              />
              <Button type="button" variant="secondary" onClick={openReferralRequest}>
                Request a referral code
              </Button>
            </div>
          </Field>
        </div>

        <div className="sm:col-span-2">
          <p className="mb-2 text-sm font-medium text-ink-700">Shop location</p>
          <MapPicker
            purpose="shop_registration"
            initialCoordinates={coordinates}
            onConfirm={handleMapConfirm}
          />
          {coordinates ? (
            <p className="mt-1 text-xs text-leaf-700">Location pinned and confirmed.</p>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <Field label="Address" error={errorFor("addressLine1")}>
            <input name="addressLine1" required className={inputClass} />
          </Field>
        </div>

        <Field label="Area / locality">
          <input name="area" className={inputClass} />
        </Field>

        <Field label="Landmark (optional)">
          <input name="landmark" className={inputClass} />
        </Field>

        <Field label="City" error={errorFor("city")}>
          <input name="city" required defaultValue="Pune" className={inputClass} />
        </Field>

        <Field label="State">
          <input name="state" defaultValue="Maharashtra" className={inputClass} />
        </Field>

        <Field label="PIN code" hint="6 digits" error={errorFor("pincode")}>
          <input
            name="pincode"
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            className={inputClass}
            onBlur={() => void precheck("pincode")}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field
            label="Shop type"
            hint={
              professional
                ? "Pick your speciality under categories below — e.g. CA, Advocate, Dentist."
                : "We'll suggest the right products to list based on this."
            }
            error={errorFor("shopType")}
          >
            <select
              name="shopType"
              required
              value={shopType}
              onChange={(e) => setShopType(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Select a shop type
              </option>
              <optgroup label="Shops and stores">
                {shopTypes.filter((t) => !isProfessionalShopType(t.key)).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Professional offices and practices">
                {shopTypes.filter((t) => isProfessionalShopType(t.key)).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="Shop categories"
            hint="Choose every kind of business your shop runs — you can pick several and change them later."
            error={errorFor("categoryIds")}
          >
            <ShopCategoryPicker
              value={categoryIds}
              onChange={setCategoryIds}
              error={null}
              initialCategories={initialCategories}
              firstGroups={CATEGORY_GROUPS_FOR[shopType] ?? []}
            />
          </Field>
        </div>

        <div className="rounded-lg border border-cream-200 p-4 sm:col-span-2">
          <p className="text-sm font-medium text-ink-700">Business registration</p>
          <p className="mb-3 mt-0.5 text-xs text-ink-500">
            Any one of the following is required. We use these to make sure each shop is registered only once.
          </p>
          {errorFor("identifiers") ? (
            <p className="mb-3 text-xs text-red-600">{errorFor("identifiers")}</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Shop Act / Gumasta licence number"
                hint="As printed on your Shop Act certificate or intimation receipt."
                error={errorFor("shopActNumber")}
              >
                <input
                  name="shopActNumber"
                  autoComplete="off"
                  maxLength={60}
                  className={inputClass}
                  onBlur={() => void precheck("shopActNumber")}
                />
              </Field>
            </div>

            <Field label="PAN" hint="e.g. ABCDE1234F. Stored encrypted." error={errorFor("panNumber")}>
              <input
                name="panNumber"
                autoComplete="off"
                maxLength={20}
                className={`${inputClass} uppercase`}
                onChange={(e) => setPanEntered(e.target.value.trim() !== "")}
                onBlur={() => void precheck("panNumber")}
              />
            </Field>

            {panEntered ? (
              <Field label="Name on PAN card" error={errorFor("panHolderName")}>
                <input name="panHolderName" required maxLength={120} className={inputClass} />
              </Field>
            ) : null}

            <div className="sm:col-span-2">
              <Field
                label="Udyam / Udyog Aadhaar number"
                hint="UDYAM-MH-26-0012345, or an old Udyog Aadhaar number like MH26A0012345. Not your personal Aadhaar number."
                error={errorFor("udyamNumber")}
              >
                <input
                  name="udyamNumber"
                  autoComplete="off"
                  maxLength={40}
                  className={`${inputClass} uppercase`}
                  onBlur={() => void precheck("udyamNumber")}
                />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field label="GST number (GSTIN)" hint="e.g. 27ABCDE1234F1Z0" error={errorFor("gstin")}>
                <input
                  name="gstin"
                  autoComplete="off"
                  maxLength={20}
                  className={`${inputClass} uppercase`}
                />
              </Field>
            </div>
          </div>
        </div>

        {shownNotices.length > 0 ? (
          <div className="space-y-2 sm:col-span-2">
            {shownNotices.map((notice) => (
              <Alert key={notice.message} tone={notice.tone}>
                {notice.message}
              </Alert>
            ))}
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <Field label={professional ? "About your practice / office (optional)" : "About your shop (optional)"}>
            <textarea name="description" rows={3} className={inputClass} />
          </Field>
        </div>

        {askTurnover && feeRule ? (
          <div className="rounded-lg border border-kesari-100 bg-kesari-50 p-4 sm:col-span-2">
            <Field
              label="Annual turnover (₹) *"
              hint="Last financial year, in rupees — e.g. 1500000 for ₹15 lakh."
              error={errorFor("annualTurnover")}
            >
              <input
                name="annualTurnover"
                required
                inputMode="numeric"
                autoComplete="off"
                maxLength={20}
                value={turnover}
                onChange={(e) => {
                  setTurnover(e.target.value);
                  // The discount was priced on the old fee.
                  setCoupon(null);
                }}
                className={inputClass}
              />
            </Field>
            <ul className="mt-3 space-y-1 text-sm" data-testid="turnover-slabs">
              {([1, 2, 3] as const).map((slab) => {
                const current = turnoverRupees !== null && turnoverSlab(turnoverRupees, feeRule) === slab;
                const fee = slab === 1 ? feeRule.slab1FeePaise : slab === 2 ? feeRule.slab2FeePaise : feeRule.slab3FeePaise;
                return (
                  <li
                    key={slab}
                    className={`flex justify-between gap-3 rounded px-2 py-1 ${current ? "bg-white font-semibold text-ink-900 ring-1 ring-kesari-300" : "text-ink-600"}`}
                  >
                    <span>
                      Slab {slab}: {turnoverSlabLabel(slab, feeRule)}
                    </span>
                    <span>{formatPaiseCompact(fee)} + GST</span>
                  </li>
                );
              })}
            </ul>
            {feePreview === null ? (
              <p className="mt-2 text-sm text-ink-500">Enter your turnover to see the registration fee.</p>
            ) : turnoverRupees !== null ? (
              <p className="mt-2 text-xs text-ink-500">
                Turnover {formatRupeesIndian(turnoverRupees)} — slab {turnoverSlab(turnoverRupees, feeRule)}
              </p>
            ) : null}
          </div>
        ) : null}

        {feeQuote && feeBasePaise !== null && feeBasePaise > 0 ? (
          <RegistrationFeeSummary
            basePaise={feeBasePaise}
            gstRateBp={feeQuote.gstRateBp}
            turnoverRupees={askTurnover ? turnoverRupees : null}
            coupon={coupon}
            onCoupon={setCoupon}
            serverError={errorFor("couponCode")}
          />
        ) : null}

        {professional ? null : (
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={deliveryAvailable}
                onChange={(e) => setDeliveryAvailable(e.target.checked)}
              />
              We deliver to customers
            </label>
          </div>
        )}

        {deliveryAvailable && !professional ? (
          <Field label="Delivery fee (₹)">
            <input
              name="deliveryFee"
              type="number"
              min={0}
              defaultValue={20}
              className={inputClass}
            />
          </Field>
        ) : null}

        {error ? (
          <div className="sm:col-span-2">
            <Alert tone={errorTone}>{error}</Alert>
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <Button
            type="submit"
            size="lg"
            disabled={submitting || locked}
            aria-busy={submitting}
            className="w-full"
          >
            {submitting ? (
              <>
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    className="opacity-25"
                  />
                  <path
                    d="M22 12a10 10 0 0 0-10-10"
                    stroke="currentColor"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                </svg>
                Submitting…
              </>
            ) : locked ? (
              "Waiting for approval"
            ) : (
              "Submit for approval"
            )}
          </Button>
        </div>
        </fieldset>
      </form>
    </Card>
  );
}
