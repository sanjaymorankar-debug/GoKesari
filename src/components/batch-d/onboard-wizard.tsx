"use client";

/**
 * Operator-Limited onboarding wizard (batch-2026-10 WS-D, F8.4.2):
 * owner's email → the owner's code → the shop → the registration fee.
 * The server decides everything; this only walks the steps.
 */
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

interface Option {
  value: string;
  label: string;
}

type Step = "email" | "code" | "shop" | "fee" | "done";

async function send<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = data?.error?.details?.fields as Record<string, string> | undefined;
    const detail = fields ? ` ${Object.values(fields).join(" ")}` : "";
    throw new Error(`${data?.error?.message ?? "Something went wrong."}${detail}`);
  }
  return data as T;
}

export function OnboardWizard({
  shopTypes,
  categories,
  resume,
}: {
  shopTypes: Option[];
  categories: Option[];
  resume: { sessionId: string; ownerEmail: string; status: string } | null;
}) {
  const [step, setStep] = useState<Step>(resume ? (resume.status === "OWNER_VERIFIED" ? "shop" : "code") : "email");
  const [sessionId, setSessionId] = useState<string | null>(resume?.sessionId ?? null);
  const [ownerEmail, setOwnerEmail] = useState(resume?.ownerEmail ?? "");
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shopId, setShopId] = useState<string | null>(null);
  const [fee, setFee] = useState<{ mode: string; linkUrl: string | null; checkoutUrl: string | null; amountPaise: number } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ shopType: shopTypes[0]?.value ?? "", categoryId: categories[0]?.value ?? "" });

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-4" data-testid="onboard-wizard">
      <ol className="flex flex-wrap gap-2 text-xs font-semibold text-ink-600">
        {(["email", "code", "shop", "fee"] as const).map((s, i) => (
          <li key={s} className={step === s ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1"}>
            {i + 1}. {s === "email" ? "Owner's email" : s === "code" ? "Owner's code" : s === "shop" ? "Shop details" : "Registration fee"}
          </li>
        ))}
      </ol>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {step === "email" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await send<{ sessionId: string; maskedEmail: string }>("/api/operator/onboarding", { ownerEmail });
              setSessionId(r.sessionId);
              setMaskedEmail(r.maskedEmail);
              setStep("code");
            });
          }}
        >
          <Field label="Shop owner's email" hint="We email the owner a code. Nothing is registered until they read it to you.">
            <input className={inputClass} type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} autoComplete="off" />
          </Field>
          <Button type="submit" disabled={busy}>Send code to the owner</Button>
        </form>
      ) : null}

      {step === "code" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await send(`/api/operator/onboarding/${sessionId}/verify`, { code });
              setStep("shop");
            });
          }}
        >
          <p className="text-sm text-ink-700">Code sent to {maskedEmail ?? ownerEmail}. Ask the owner to read it out.</p>
          <Field label="Owner's code">
            <input className={inputClass} inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </Field>
          <Button type="submit" disabled={busy}>Confirm owner</Button>
        </form>
      ) : null}

      {step === "shop" ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await send<{ shop: { id: string } }>(`/api/operator/onboarding/${sessionId}/shop`, {
                name: form.name,
                ownerName: form.ownerName,
                phone: form.phone,
                email: ownerEmail || null,
                addressLine1: form.addressLine1,
                area: form.area || null,
                city: form.city,
                pincode: form.pincode,
                shopType: form.shopType,
                categoryIds: form.categoryId ? [form.categoryId] : [],
                shopActNumber: form.shopActNumber || null,
                gstin: form.gstin || null,
                udyamNumber: form.udyamNumber || null,
                referralCode: form.referralCode || null,
              });
              setShopId(r.shop.id);
              setStep("fee");
            });
          }}
        >
          {[
            ["name", "Shop name"],
            ["ownerName", "Owner's name"],
            ["phone", "Owner's mobile (10 digits)"],
            ["addressLine1", "Address"],
            ["area", "Area"],
            ["city", "City"],
            ["pincode", "PIN code"],
            ["shopActNumber", "Shop Act licence no."],
            ["gstin", "GSTIN"],
            ["udyamNumber", "Udyam no."],
            ["referralCode", "Referral code"],
          ].map(([key, label]) => (
            <Field key={key} label={label}>
              <input className={inputClass} value={form[key] ?? ""} onChange={set(key)} required={["name", "ownerName", "phone", "addressLine1", "city", "pincode"].includes(key)} />
            </Field>
          ))}
          <Field label="Shop type">
            <select className={inputClass} value={form.shopType} onChange={set("shopType")}>
              {shopTypes.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Shop category">
            <select className={inputClass} value={form.categoryId} onChange={set("categoryId")}>
              {categories.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>Register the shop</Button>
          </div>
        </form>
      ) : null}

      {step === "fee" ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">The shop is registered and waits for approval. Collect the registration fee online:</p>
          <div className="flex flex-wrap gap-2">
            {(["LINK", "CHECKOUT"] as const).map((mode) => (
              <Button
                key={mode}
                variant={mode === "LINK" ? "primary" : "secondary"}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await send<{ mode: string; linkUrl: string | null; checkoutUrl: string | null; amountPaise: number }>(
                      `/api/operator/onboarding/${sessionId}/fee`,
                      { mode },
                    );
                    setFee(r);
                    if (mode === "CHECKOUT" && r.checkoutUrl) window.open(r.checkoutUrl, "_blank", "noopener");
                  })
                }
              >
                {mode === "LINK" ? "Email a payment link to the owner" : "Owner pays now"}
              </Button>
            ))}
          </div>
          {fee ? (
            <Alert tone="success" title={fee.mode === "LINK" ? "Payment link emailed to the owner" : "Checkout opened"}>
              Amount ₹{(fee.amountPaise / 100).toFixed(2)}. {fee.linkUrl ?? fee.checkoutUrl ?? ""} — follow it under Payment links.
            </Alert>
          ) : null}
          {shopId ? <a className="text-sm font-semibold text-kesari-800 underline" href={`/operator/shops/${shopId}`}>Open the shop&apos;s documents</a> : null}
        </div>
      ) : null}
    </Card>
  );
}
