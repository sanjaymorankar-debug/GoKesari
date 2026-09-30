"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

export interface ReferenceRow {
  id: string;
  productCode: string;
  productName: string;
  pricePaise: number;
  unitBasis: string | null;
  sourceType: string;
  sourceName: string;
  referenceUrl: string | null;
  marketLocation: string | null;
  referencedAt: string | Date;
  verificationStatus: string;
}

const SOURCE_TYPES = [
  ["MARKET_SURVEY", "Market survey"],
  ["MANUFACTURER", "Manufacturer list"],
  ["GOVT_MANDI", "Government / mandi"],
  ["PARTNER_FEED", "Partner feed"],
  ["PMD_IMPORT", "Product-master import"],
  ["OTHER", "Other"],
];

/** Record and verify external reference prices. They are information — never a selling price and never the MRP. */
export function PriceReferencesManager({ queue, status }: { queue: ReferenceRow[]; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [f, setF] = useState({
    productId: "",
    price: "",
    unitBasis: "",
    sourceType: "MARKET_SURVEY",
    sourceName: "",
    referenceUrl: "",
    marketLocation: "",
    referencedAt: new Date().toISOString().slice(0, 16),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function add() {
    const price = Number(f.price.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(price) || price <= 0) return setError("Enter the price in rupees.");
    const ok = await call("/api/admin/price-references", "POST", {
      productId: f.productId.trim(),
      pricePaise: rupeesToPaise(price),
      unitBasis: f.unitBasis || null,
      sourceType: f.sourceType,
      sourceName: f.sourceName,
      referenceUrl: f.referenceUrl || null,
      marketLocation: f.marketLocation || null,
      referencedAt: new Date(f.referencedAt).toISOString(),
    });
    if (ok) setF({ ...f, price: "", sourceName: "", referenceUrl: "", unitBasis: "" });
  }

  return (
    <div className="space-y-6">
      <Alert tone="info">
        A reference price comes from outside Gokesari. It is <strong>not the MRP</strong> and{" "}
        <strong>not any shop&apos;s selling price</strong>, and it never changes either.
      </Alert>

      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium text-ink-700">Record a reference price</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Product code (e.g. P00042)">
            <input className={inputClass} value={f.productId} onChange={set("productId")} />
          </Field>
          <Field label="Price ₹">
            <input className={inputClass} inputMode="decimal" value={f.price} onChange={set("price")} />
          </Field>
          <Field label="Price is for (e.g. per 500 g pack)">
            <input className={inputClass} value={f.unitBasis} onChange={set("unitBasis")} />
          </Field>
          <Field label="Source type">
            <select className={inputClass} value={f.sourceType} onChange={set("sourceType")}>
              {SOURCE_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source name">
            <input className={inputClass} value={f.sourceName} onChange={set("sourceName")} />
          </Field>
          <Field label="Market / location">
            <input className={inputClass} value={f.marketLocation} onChange={set("marketLocation")} />
          </Field>
          <Field label="Reference URL (optional)">
            <input className={inputClass} value={f.referenceUrl} onChange={set("referenceUrl")} />
          </Field>
          <Field label="Observed on">
            <input className={inputClass} type="datetime-local" value={f.referencedAt} onChange={set("referencedAt")} />
          </Field>
        </div>
        <Button disabled={busy || !f.productId.trim() || !f.sourceName.trim()} onClick={add}>
          Record
        </Button>
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex gap-2">
        {["UNVERIFIED", "VERIFIED", "REJECTED"].map((s) => (
          <a
            key={s}
            href={`/admin/price-references?status=${s}`}
            className={`rounded-lg border px-3 py-1 text-sm ${status === s ? "border-kesari-600 bg-kesari-50 text-kesari-700" : "border-cream-200 text-ink-600"}`}
          >
            {s.toLowerCase()}
          </a>
        ))}
      </div>

      <div className="space-y-2">
        {queue.length === 0 ? <p className="text-sm text-ink-500">Nothing here.</p> : null}
        {queue.map((r) => (
          <Card key={r.id} className="space-y-2 p-4 text-sm" data-testid="price-reference">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-ink-900">
                {r.productCode} · {r.productName}
              </p>
              <span className="flex items-center gap-2">
                <Money paise={r.pricePaise} />
                <Badge tone={r.verificationStatus === "VERIFIED" ? "success" : r.verificationStatus === "REJECTED" ? "danger" : "warning"}>
                  {r.verificationStatus.toLowerCase()}
                </Badge>
              </span>
            </div>
            <p className="text-xs text-ink-500">
              {r.sourceName} ({r.sourceType.replace(/_/g, " ").toLowerCase()}){r.unitBasis ? ` · ${r.unitBasis}` : ""}
              {r.marketLocation ? ` · ${r.marketLocation}` : ""} · observed {new Date(r.referencedAt).toLocaleDateString("en-IN")}
              {r.referenceUrl ? (
                <>
                  {" · "}
                  <a href={r.referenceUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    source
                  </a>
                </>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                className={`${inputClass} min-w-0 flex-1`}
                placeholder="Note (required to reject)"
                value={notes[r.id] ?? ""}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
              />
              {r.verificationStatus !== "VERIFIED" ? (
                <Button size="sm" disabled={busy} onClick={() => call(`/api/admin/price-references/${r.id}`, "PATCH", { action: "verify", note: notes[r.id] || null })}>
                  Verify
                </Button>
              ) : null}
              {r.verificationStatus !== "REJECTED" ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || (notes[r.id] ?? "").trim().length < 3}
                  onClick={() => call(`/api/admin/price-references/${r.id}`, "PATCH", { action: "reject", note: notes[r.id] })}
                >
                  Reject
                </Button>
              ) : null}
              {r.verificationStatus !== "UNVERIFIED" ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => call(`/api/admin/price-references/${r.id}`, "PATCH", { action: "reopen", note: notes[r.id] || null })}>
                  Reopen
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
