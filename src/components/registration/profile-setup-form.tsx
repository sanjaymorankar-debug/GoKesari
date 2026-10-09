"use client";

/** Module 3: complete the profile of a self-registered shop. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

interface Shop {
  id: string;
  name: string;
  registrationNumber: string;
  ownerName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  pincode: string;
  shopType: string;
  gstin: string | null;
  gstStatus: string;
  panStatus: string;
  locationVerified: boolean;
  profileCompletedAt: string | null;
}

export function ProfileSetupForm({
  shop,
  missing,
  categories,
  fssai,
  shopTypes,
}: {
  shop: Shop;
  missing: string[];
  categories: number;
  fssai: { needed: boolean; onFile: boolean };
  shopTypes: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    ownerName: shop.ownerName,
    addressLine1: shop.addressLine1,
    addressLine2: shop.addressLine2 ?? "",
    city: shop.city,
    state: shop.state ?? "",
    pincode: shop.pincode,
    shopType: shop.shopType,
    gstin: shop.gstin ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ complete: boolean; missing: string[]; warnings: string[]; gstin: { ok: boolean; legalName?: string | null; tradeName?: string | null; status?: string | null; stateName?: string | null; message?: string } | null } | null>(null);
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues({ ...values, [k]: e.target.value });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/shops/${shop.id}/profile-setup`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...values, addressLine2: values.addressLine2 || null, state: values.state || null, gstin: values.gstin || null }),
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not save.");
      return;
    }
    setResult(data);
    router.refresh();
  }

  const stillMissing = result?.missing ?? missing;
  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result?.complete ? <Alert tone="success" title="Profile complete">Customers near you can now find your shop. Add your products and set prices next.</Alert> : null}
      {result?.gstin?.ok ? (
        <Alert tone="info" title="GSTIN found on the GST portal">
          {result.gstin.legalName}
          {result.gstin.tradeName ? ` (${result.gstin.tradeName})` : ""} · {result.gstin.status} · {result.gstin.stateName}. GoKesari confirms it shortly.
        </Alert>
      ) : null}
      {result?.warnings?.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
      <Card className="p-4">
        <form onSubmit={save} className="space-y-3">
          <Field label="Owner's name"><input className={inputClass} value={values.ownerName} onChange={set("ownerName")} required /></Field>
          <Field label="Shop address"><input className={inputClass} value={values.addressLine1} onChange={set("addressLine1")} placeholder="Shop no., building, street" required /></Field>
          <Field label="Area / landmark (optional)"><input className={inputClass} value={values.addressLine2} onChange={set("addressLine2")} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="City / town"><input className={inputClass} value={values.city} onChange={set("city")} required /></Field>
            <Field label="PIN code"><input className={inputClass} value={values.pincode} onChange={set("pincode")} inputMode="numeric" maxLength={6} required /></Field>
          </div>
          <Field label="State"><input className={inputClass} value={values.state} onChange={set("state")} placeholder="e.g. Maharashtra" /></Field>
          <Field label="Type of shop">
            <select className={inputClass} value={values.shopType} onChange={set("shopType")}>
              {shopTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="GSTIN (if registered)" hint="Checked with the GST system when you save.">
            <input className={`${inputClass} uppercase`} value={values.gstin} onChange={set("gstin")} maxLength={15} />
          </Field>
          <Button type="submit" disabled={busy} className="w-full">{busy ? "Saving…" : "Save"}</Button>
        </form>
      </Card>
      <Card className="space-y-2 p-4 text-sm">
        <p className="font-medium text-ink-900">Next steps</p>
        <ul className="space-y-1">
          <li>{categories > 0 ? "✅" : "⬜"} <Link className="text-kesari-600 underline" href="/shop/product-categories">Choose your product categories</Link> ({categories} chosen) — each adds its products with stock 100; you fill in prices.</li>
          <li>{shop.locationVerified ? "✅" : "⬜"} <Link className="text-kesari-600 underline" href="/shop">Confirm your shop&apos;s location on the map</Link></li>
          <li>{shop.panStatus === "VERIFIED" ? "✅" : "⬜"} <Link className="text-kesari-600 underline" href="/shop/verification">Add PAN and other documents</Link></li>
          {fssai.needed ? (
            <li>{fssai.onFile ? "✅" : "⬜"} <Link className="text-kesari-600 underline" href="/shop/verification">Add your FSSAI licence or registration</Link> — required by law for a shop that sells food.</li>
          ) : null}
          <li><Link className="text-kesari-600 underline" href="/shop/wallet">Top up your shop wallet</Link> so you can accept orders.</li>
        </ul>
        {stillMissing.length ? <p className="text-xs text-ink-500">Still needed for a complete profile: {stillMissing.join(", ")}.</p> : null}
      </Card>
    </div>
  );
}
