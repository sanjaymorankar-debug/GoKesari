"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button, Field, inputClass } from "@/components/ui";
import { invoiceTotals, isInterState, lineTax, grossPaise, STANDARD_GST_RATES_BP, stateOfGstin, taxOnTaxable, type LineTax } from "@/lib/accounts/gst-math";
import { GST_STATES, isValidGstin } from "@/lib/gst-states";
import { accountsApi, qty, rupees } from "./api";
import { FormError, parseRupees } from "./payment-forms";
import { formatStock } from "@/lib/stock-quantity";

/** The fields of GET stock/listings this form uses. */
interface Listing {
  shopProductId: string;
  name: string;
  sellableUnit: string;
  hsn: string | null;
  gstRateBp: number | null;
  barcode: string | null;
  mrpPaise: number | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineStock: number;
  offlineStock: number;
  isActive: boolean;
}

interface LineDraft {
  key: number;
  shopProductId: string | null;
  description: string;
  hsn: string;
  unit: string;
  qty: string;
  rate: string;
  discount: string;
  gstBp: number;
}

type Mode = "CASH" | "UPI" | "BANK" | "CARD" | "CREDIT";

const MODES: { value: Mode; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK", label: "Bank" },
  { value: "CARD", label: "Card" },
  { value: "CREDIT", label: "Credit (pay later)" },
];

let nextKey = 1;
const emptyLine = (): LineDraft => ({ key: nextKey++, shopProductId: null, description: "", hsn: "", unit: "", qty: "1", rate: "", discount: "", gstBp: 1800 });

function parseQtyMilli(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

const pct = (bp: number) => `${bp / 100}%`;

/** Mirrors createSalesInvoice: inclusive prices have the taxable value backed out of them. */
function computeLine(l: LineDraft, inclusive: boolean, inter: boolean): LineTax | null {
  const qtyMilli = parseQtyMilli(l.qty);
  const ratePaise = parseRupees(l.rate);
  const discountPaise = l.discount.trim() ? parseRupees(l.discount) : 0;
  if (qtyMilli == null || ratePaise == null || discountPaise == null) return null;
  if (!inclusive) {
    const t = lineTax({ qtyMilli, ratePaise, discountPaise, gstRateBp: l.gstBp }, inter);
    return t.taxablePaise < 0 ? null : t;
  }
  const gross = grossPaise(qtyMilli, ratePaise);
  const after = gross - discountPaise;
  if (after < 0) return null;
  const taxable = Math.round((after * 10_000) / (10_000 + l.gstBp));
  return taxOnTaxable(taxable, l.gstBp, inter, 0, { gross, discount: discountPaise });
}

/**
 * New GST sales invoice (docs/inventory-accounting-2026-10, Part 2): buyer,
 * place of supply, payment mode and lines — products from the shop's stock
 * or free text — with a live CGST + SGST / IGST preview computed exactly as
 * the server will. Submits POST sales and opens the new invoice.
 */
export function SalesInvoiceForm({ shopId, shopQuery = "", sellerState, today }: { shopId: string; shopQuery?: string; sellerState: string | null; today: string }) {
  const router = useRouter();
  const formId = useId();
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [buyerName, setBuyerName] = useState("");
  const [buyerGstin, setBuyerGstin] = useState("");
  const [posChoice, setPosChoice] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [mode, setMode] = useState<Mode>("CASH");
  const [dueDate, setDueDate] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    accountsApi<Listing[]>(shopId, "stock/listings")
      .then((rows) => live && setListings(rows.filter((r) => r.isActive)))
      .catch(() => live && setListingError("Could not load your products. You can still type items."));
    return () => {
      live = false;
    };
  }, [shopId]);

  const gstinClean = buyerGstin.replace(/\s+/g, "").toUpperCase();
  const gstinValid = gstinClean ? isValidGstin(gstinClean) : true;
  const autoPos = (gstinClean && gstinValid ? stateOfGstin(gstinClean) : null) ?? sellerState ?? "";
  const pos = posChoice ?? autoPos;
  const inter = isInterState(sellerState, pos);

  const computed = useMemo(() => lines.map((l) => computeLine(l, inclusive, inter)), [lines, inclusive, inter]);
  const totals = useMemo(() => invoiceTotals(computed.filter((t): t is LineTax => t != null)), [computed]);

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pick(key: number, item: Listing) {
    const price = item.offlinePricePaise ?? item.onlinePricePaise ?? item.mrpPaise;
    update(key, {
      shopProductId: item.shopProductId,
      description: item.name,
      hsn: item.hsn ?? "",
      unit: item.sellableUnit,
      gstBp: item.gstRateBp ?? 0,
      rate: price != null ? (price / 100).toFixed(2) : "",
    });
    setActiveLine(null);
  }

  function matches(query: string): Listing[] {
    const q = query.trim().toLowerCase();
    if (!q || !listings) return [];
    return listings.filter((i) => i.name.toLowerCase().includes(q) || i.barcode === q).slice(0, 6);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const filled = lines.filter((l) => l.description.trim() || l.rate.trim());
    if (filled.length === 0) return setError("Add at least one item.");
    for (const [i, l] of filled.entries()) {
      if (!l.description.trim()) return setError(`Line ${i + 1}: enter the item name.`);
      if (parseQtyMilli(l.qty) == null) return setError(`Line ${i + 1}: enter the quantity.`);
      if (parseRupees(l.rate) == null) return setError(`Line ${i + 1}: enter the rate in rupees.`);
      if (l.discount.trim() && parseRupees(l.discount) == null) return setError(`Line ${i + 1}: the discount is not a valid amount.`);
      if (!computeLine(l, inclusive, inter)) return setError(`Line ${i + 1}: the discount is more than the amount.`);
    }
    if (!gstinValid) return setError("Buyer GSTIN is not valid. Check it or leave it empty.");
    if (mode === "CREDIT" && !buyerName.trim()) return setError("A credit sale needs the customer's name.");
    if (invoiceDate > today) return setError("The invoice date cannot be in the future.");
    setBusy(true);
    try {
      const invoice = await accountsApi<{ id: string }>(shopId, "sales", {
        body: {
          buyerName: buyerName.trim() || null,
          buyerGstin: gstinClean || null,
          placeOfSupply: /^\d{2}$/.test(pos) ? pos : null,
          invoiceDate,
          paymentMode: mode,
          dueDate: mode === "CREDIT" && dueDate ? dueDate : null,
          pricesIncludeTax: inclusive,
          note: note.trim() || null,
          lines: filled.map((l) => ({
            shopProductId: l.shopProductId,
            description: l.description.trim(),
            hsn: l.hsn.trim() || null,
            qtyMilli: parseQtyMilli(l.qty)!,
            unit: l.unit.trim() || null,
            ratePaise: parseRupees(l.rate)!,
            discountPaise: l.discount.trim() ? parseRupees(l.discount)! : 0,
            gstRateBp: l.gstBp,
          })),
        },
      });
      router.push(`/shop/accounts/sales/${invoice.id}${shopQuery}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invoice.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 lg:grid-cols-[1fr_20rem]" aria-label="New sales invoice">
      <div className="flex min-w-0 flex-col gap-3">
        {/* ---------------------------------------------------------- buyer */}
        <section className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-2" aria-labelledby={`${formId}-buyer`}>
          <h2 id={`${formId}-buyer`} className="text-base font-bold text-ink-900 sm:col-span-2">
            Buyer
          </h2>
          <Field label={mode === "CREDIT" ? "Customer name" : "Customer name (optional)"}>
            <input className={inputClass} value={buyerName} maxLength={160} onChange={(e) => setBuyerName(e.target.value)} required={mode === "CREDIT"} />
          </Field>
          <Field label="Buyer GSTIN (optional)" error={gstinValid ? undefined : "Not a valid GSTIN."} hint="For a B2B invoice.">
            <input className={`${inputClass} uppercase`} value={buyerGstin} maxLength={15} onChange={(e) => setBuyerGstin(e.target.value)} autoCapitalize="characters" spellCheck={false} aria-invalid={!gstinValid} />
          </Field>
          <Field label="Place of supply" hint={posChoice ? undefined : gstinClean && gstinValid ? "From the buyer's GSTIN." : "Your shop's state."}>
            <select className={inputClass} value={pos} onChange={(e) => setPosChoice(e.target.value)}>
              {pos ? null : <option value="">— Choose state —</option>}
              {GST_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Invoice date">
            <input type="date" className={inputClass} value={invoiceDate} max={today} onChange={(e) => setInvoiceDate(e.target.value)} required />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-ink-700">Payment</legend>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
              {MODES.map((m) => (
                <label key={m.value} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-xl border px-2 text-center text-sm font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-kesari-500 ${mode === m.value ? "border-kesari-700 bg-kesari-50 text-kesari-800" : "border-[var(--gk-line)] bg-white text-ink-700"}`}>
                  <input type="radio" name="paymentMode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} className="sr-only" />
                  {m.label}
                </label>
              ))}
            </div>
          </fieldset>
          {mode === "CREDIT" ? (
            <Field label="Due date (optional)">
              <input type="date" className={inputClass} value={dueDate} min={invoiceDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          ) : null}
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-700 sm:col-span-2">
            <input type="checkbox" className="h-5 w-5" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} />
            Prices include GST (MRP-style)
          </label>
        </section>

        {/* ---------------------------------------------------------- lines */}
        <section className="flex flex-col gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3" aria-labelledby={`${formId}-items`}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 id={`${formId}-items`} className="text-base font-bold text-ink-900">
              Items
            </h2>
            <span className="text-xs text-ink-600">{listings ? `${listings.length} products in your shop` : listingError ? "" : "Loading products…"}</span>
          </div>
          {listingError ? <p className="text-xs text-amber-800">{listingError}</p> : null}
          <ol className="flex flex-col gap-2">
            {lines.map((l, i) => {
              const t = computed[i];
              const suggestions = activeLine === l.key && !l.shopProductId ? matches(l.description) : [];
              const gstOptions = (STANDARD_GST_RATES_BP as readonly number[]).includes(l.gstBp) ? STANDARD_GST_RATES_BP : [...STANDARD_GST_RATES_BP, l.gstBp].sort((a, b) => a - b);
              return (
                <li key={l.key} className="rounded-xl border border-[var(--gk-line)] bg-cream-50 p-2">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field label={`Item ${i + 1}`} hint={l.shopProductId ? `From your stock · ${l.unit}` : "Type to search your products, or any text."}>
                        <input
                          className={inputClass}
                          value={l.description}
                          maxLength={200}
                          onFocus={() => setActiveLine(l.key)}
                          onKeyDown={(e) => e.key === "Escape" && setActiveLine(null)}
                          onChange={(e) => {
                            setActiveLine(l.key);
                            update(l.key, { description: e.target.value, shopProductId: null });
                          }}
                          autoComplete="off"
                        />
                      </Field>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))} aria-label={`Remove item ${i + 1}`}>
                      ✕
                    </Button>
                  </div>
                  {suggestions.length ? (
                    <ul className="mt-1 overflow-hidden rounded-xl border border-[var(--gk-line)] bg-white" aria-label={`Matching products for item ${i + 1}`}>
                      {suggestions.map((s) => (
                        <li key={s.shopProductId}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(l.key, s)}
                            className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-sm hover:bg-kesari-50 focus:bg-kesari-50 focus:outline-none"
                          >
                            <span className="min-w-0 truncate font-medium text-ink-900">
                              {s.name} <span className="font-normal text-ink-600">· {s.sellableUnit}</span>
                            </span>
                            <span className="shrink-0 text-xs text-ink-600">
                              {formatStock(s.offlineStock + s.onlineStock)} in stock{s.gstRateBp != null ? ` · GST ${pct(s.gstRateBp)}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                    <Field label="Qty">
                      <input className={inputClass} inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} />
                    </Field>
                    <Field label={inclusive ? "Rate ₹ (incl. GST)" : "Rate ₹ (before GST)"}>
                      <input className={inputClass} inputMode="decimal" value={l.rate} onChange={(e) => update(l.key, { rate: e.target.value })} placeholder="0.00" />
                    </Field>
                    <Field label="Discount ₹">
                      <input className={inputClass} inputMode="decimal" value={l.discount} onChange={(e) => update(l.key, { discount: e.target.value })} placeholder="0" />
                    </Field>
                    <Field label="GST %">
                      <select className={inputClass} value={l.gstBp} onChange={(e) => update(l.key, { gstBp: Number(e.target.value) })}>
                        {gstOptions.map((bp) => (
                          <option key={bp} value={bp}>
                            {pct(bp)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="HSN">
                      <input className={inputClass} inputMode="numeric" value={l.hsn} maxLength={8} onChange={(e) => update(l.key, { hsn: e.target.value })} />
                    </Field>
                  </div>
                  <p className="mt-1 text-right text-xs text-ink-700 tabular-nums">
                    {t ? (
                      <>
                        Taxable {rupees(t.taxablePaise)} + GST {rupees(t.taxPaise)} = <strong className="text-ink-900">{rupees(t.totalPaise)}</strong>
                      </>
                    ) : (
                      "—"
                    )}
                  </p>
                </li>
              );
            })}
          </ol>
          <div>
            <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              + Add item
            </Button>
          </div>
          <Field label="Note on invoice (optional)">
            <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </section>
      </div>

      {/* ---------------------------------------------------------- preview */}
      <aside className="flex flex-col gap-2 self-start rounded-2xl bg-green-100 p-3 lg:sticky lg:top-4" aria-labelledby={`${formId}-preview`} aria-live="polite">
        <h2 id={`${formId}-preview`} className="text-base font-bold text-ink-900">
          Invoice total
        </h2>
        <p className="text-xs font-semibold text-green-900">{inter ? "Inter-state supply: IGST" : "Within your state: CGST + SGST"}</p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm tabular-nums">
          <dt className="text-ink-700">Taxable value</dt>
          <dd className="text-right">{rupees(totals.taxablePaise)}</dd>
          {inter ? (
            <>
              <dt className="text-ink-700">IGST</dt>
              <dd className="text-right">{rupees(totals.igstPaise)}</dd>
            </>
          ) : (
            <>
              <dt className="text-ink-700">CGST</dt>
              <dd className="text-right">{rupees(totals.cgstPaise)}</dd>
              <dt className="text-ink-700">SGST</dt>
              <dd className="text-right">{rupees(totals.sgstPaise)}</dd>
            </>
          )}
          {totals.roundOffPaise ? (
            <>
              <dt className="text-ink-700">Round off</dt>
              <dd className="text-right">{rupees(totals.roundOffPaise)}</dd>
            </>
          ) : null}
          <dt className="mt-1 border-t border-green-300 pt-1 font-bold text-ink-900">Total</dt>
          <dd className="mt-1 border-t border-green-300 pt-1 text-right text-lg font-bold text-ink-900">{rupees(totals.totalPaise)}</dd>
        </dl>
        <p className="text-xs text-ink-700">
          {lines.filter((l, i) => computed[i] && l.description.trim()).length} item(s)
          {lines.some((l) => l.shopProductId) ? ` · stock goes down by the quantities sold (${lines.filter((l) => l.shopProductId).map((l) => qty(parseQtyMilli(l.qty) ?? 0)).join(", ")})` : ""}
        </p>
        {sellerState ? null : <p className="text-xs font-semibold text-red-800">Add your shop&apos;s GSTIN or state before issuing GST invoices.</p>}
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? "Creating…" : "Create invoice"}
        </Button>
        <FormError message={error} />
      </aside>
    </form>
  );
}
