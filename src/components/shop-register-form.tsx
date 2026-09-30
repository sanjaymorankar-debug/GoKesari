"use client";

import { ShopCategoryPicker } from "@/components/shop-category-picker";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { rupeesToPaise } from "@/lib/money";
import {
  parsePanNumber,
  parseShopActNumber,
  parseUdyamNumber,
  type ParseResult,
  type ShopIdentifierField,
} from "@/lib/shop-identity";
import { SHOP_TYPES } from "@/lib/shop-types";

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
 */

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

export function ShopRegisterForm() {
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
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );

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

    if (!get("shopActNumber") && !get("panNumber") && !get("udyamNumber")) {
      const message = "Enter at least one of these numbers.";
      setErrorTone("danger");
      setError("Enter at least one of: Shop Act licence, PAN or Udyam number.");
      setFieldErrors({ shopActNumber: message, panNumber: message, udyamNumber: message });
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
          shopActNumber: get("shopActNumber") || null,
          panNumber: get("panNumber") || null,
          panHolderName: get("panHolderName") || null,
          udyamNumber: get("udyamNumber") || null,
          deliveryAvailable,
          deliveryFeePaise:
            deliveryAvailable && deliveryFee ? rupeesToPaise(Number(deliveryFee)) : 0,
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
      // "Already registered" is not a mistake in what the owner typed.
      setErrorTone(payload?.error?.details?.reason === "DUPLICATE_SHOP" ? "warning" : "danger");
      setError(payload?.error?.message ?? "Could not register the shop.");
      return false;
    }
    router.push("/shop");
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
      <form ref={formRef} onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Shop name" error={errorFor("name")}>
            <input name="name" required className={inputClass} />
          </Field>
        </div>

        <Field label="Owner name" error={errorFor("ownerName")}>
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
            hint="We'll suggest the right products to list based on this."
            error={errorFor("shopType")}
          >
            <select name="shopType" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Select a shop type
              </option>
              {SHOP_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="Shop categories"
            hint="Choose every kind of business your shop runs — you can pick several and change them later."
            error={errorFor("categoryIds")}
          >
            <ShopCategoryPicker value={categoryIds} onChange={setCategoryIds} error={null} />
          </Field>
        </div>

        <div className="rounded-lg border border-cream-200 p-4 sm:col-span-2">
          <p className="text-sm font-medium text-ink-700">Business registration</p>
          <p className="mb-3 mt-0.5 text-xs text-ink-500">
            Enter at least one. We use these to make sure each shop is registered only once.
          </p>
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
          <Field label="About your shop (optional)">
            <textarea name="description" rows={3} className={inputClass} />
          </Field>
        </div>

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

        {deliveryAvailable ? (
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
            disabled={submitting}
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
            ) : (
              "Submit for approval"
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
