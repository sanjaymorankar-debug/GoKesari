"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BarcodeScanner } from "@/components/barcode-scanner";
import { Alert, Button, inputClass } from "@/components/ui";
import { PRODUCT_UNITS } from "@/lib/product-units";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11): the starter-shelf wording. Product names and units stay as they are. */
const T = {
  loadFailed: L("Could not load the suggested products.", "सुझाए गए उत्पाद लोड नहीं हो सके।", "सुचवलेली उत्पादने लोड करता आली नाहीत."),
  enterPrice: L("Enter a price for {name}, or untick it.", "{name} का दाम डालें, या उसका टिक हटाएँ।", "{name} ची किंमत टाका, किंवा त्याची टिक काढा."),
  aboveMrp: L(
    "{name}: the price cannot be above the MRP ({mrp}).",
    "{name}: दाम MRP ({mrp}) से ज़्यादा नहीं हो सकता।",
    "{name}: किंमत MRP ({mrp}) पेक्षा जास्त असू शकत नाही.",
  ),
  enterQty: L("Enter the quantity you have of {name}.", "{name} की आपके पास कितनी मात्रा है, डालें।", "{name} चे तुमच्याकडे किती प्रमाण आहे ते टाका."),
  tickOne: L("Tick at least one product.", "कम से कम एक उत्पाद पर टिक करें।", "किमान एका उत्पादनावर टिक करा."),
  publishFailed: L(
    "Could not publish the products. Please try again.",
    "उत्पाद प्रकाशित नहीं हो सके। फिर कोशिश करें।",
    "उत्पादने प्रकाशित करता आली नाहीत. पुन्हा प्रयत्न करा.",
  ),
  lookupFailed: L(
    "Could not look up the barcode. Please try again.",
    "बारकोड नहीं ढूँढा जा सका। फिर कोशिश करें।",
    "बारकोड शोधता आला नाही. पुन्हा प्रयत्न करा.",
  ),
  alreadyIn: L("{name} is already in your shop.", "{name} पहले से आपकी दुकान में है।", "{name} आधीच तुमच्या दुकानात आहे."),
  awaiting: L(
    "{name} is waiting for our team's approval — it can be listed once approved.",
    "{name} हमारी टीम की मंज़ूरी का इंतज़ार कर रहा है — मंज़ूरी के बाद जोड़ा जा सकेगा।",
    "{name} आमच्या टीमच्या मंजुरीची वाट पाहत आहे — मंजुरीनंतर जोडता येईल.",
  ),
  addedAtMrp: L("Added {name} at MRP {mrp}.", "{name} MRP {mrp} पर जोड़ा गया।", "{name} MRP {mrp} वर जोडले."),
  addedSetPrice: L("Added {name} — set your price.", "{name} जोड़ा गया — अपना दाम डालें।", "{name} जोडले — तुमची किंमत टाका."),
  enterName: L(
    "Enter the product's name as printed on the pack.",
    "पैक पर छपा उत्पाद का नाम डालें।",
    "पॅकवर छापलेले उत्पादनाचे नाव टाका.",
  ),
  enterSelling: L("Enter your selling price.", "अपना बिक्री दाम डालें।", "तुमची विक्री किंमत टाका."),
  addFailed: L("Could not add the product. Please try again.", "उत्पाद नहीं जुड़ सका। फिर कोशिश करें।", "उत्पादन जोडता आले नाही. पुन्हा प्रयत्न करा."),
  sentToTeam: L(
    "Sent to our team — it goes on sale in your shop once approved. We'll let you know.",
    "हमारी टीम को भेजा गया — मंज़ूरी के बाद यह आपकी दुकान में बिकने लगेगा। हम आपको बताएँगे।",
    "आमच्या टीमकडे पाठवले — मंजुरीनंतर हे तुमच्या दुकानात विक्रीला येईल. आम्ही तुम्हाला कळवू.",
  ),
  finding: L("Finding products for your shop…", "आपकी दुकान के लिए उत्पाद ढूँढ रहे हैं…", "तुमच्या दुकानासाठी उत्पादने शोधत आहे…"),
  scan: L("📷 Scan a barcode", "📷 बारकोड स्कैन करें", "📷 बारकोड स्कॅन करा"),
  notInCatalogue: L(
    "is not in our catalogue yet. Add it — it goes on sale once our team approves it.",
    "अभी हमारी सूची में नहीं है। इसे जोड़ें — टीम की मंज़ूरी के बाद यह बिकने लगेगा।",
    "अजून आमच्या यादीत नाही. ते जोडा — टीमच्या मंजुरीनंतर ते विक्रीला येईल.",
  ),
  namePlaceholder: L("Name as printed on the pack", "पैक पर छपा नाम", "पॅकवर छापलेले नाव"),
  productName: L("Product name", "उत्पाद का नाम", "उत्पादनाचे नाव"),
  unit: L("Unit", "इकाई", "एकक"),
  pricePlaceholder: L("Your price ₹", "आपका दाम ₹", "तुमची किंमत ₹"),
  sellingPrice: L("Selling price", "बिक्री दाम", "विक्री किंमत"),
  addProduct: L("Add product", "उत्पाद जोड़ें", "उत्पादन जोडा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  tickedOf: L(
    "of {total} products ticked. Untick what you don't sell, and change the price or quantity where yours differs.",
    "/ {total} उत्पादों पर टिक है। जो आप नहीं बेचते उनका टिक हटाएँ, और जहाँ आपका दाम या मात्रा अलग है वहाँ बदलें।",
    "/ {total} उत्पादनांवर टिक आहे. जे तुम्ही विकत नाही त्यांची टिक काढा, आणि जिथे तुमची किंमत किंवा प्रमाण वेगळे आहे तिथे बदला.",
  ),
  priceForAll: L("Price for all: % below MRP", "सबका दाम: MRP से % कम", "सर्वांची किंमत: MRP पेक्षा % कमी"),
  percentBelow: L("Percent below MRP", "MRP से कितने प्रतिशत कम", "MRP पेक्षा किती टक्के कमी"),
  apply: L("Apply", "लगाएँ", "लावा"),
  mrp: L(" · MRP {mrp}", " · MRP {mrp}", " · MRP {mrp}"),
  loose: L(" · loose — set your price", " · खुला सामान — अपना दाम डालें", " · सुटा माल — तुमची किंमत टाका"),
  price: L("Price ₹", "दाम ₹", "किंमत ₹"),
  priceOf: L("Price of {name}", "{name} का दाम", "{name} ची किंमत"),
  qty: L("Qty", "मात्रा", "प्रमाण"),
  qtyOf: L("Quantity of {name}", "{name} की मात्रा", "{name} चे प्रमाण"),
  publishing: L("Publishing…", "प्रकाशित हो रहा है…", "प्रकाशित होत आहे…"),
  publish: L("Publish {n} products", "{n} उत्पाद प्रकाशित करें", "{n} उत्पादने प्रकाशित करा"),
  or: L("Or", "या", "किंवा"),
  upload: L("upload your own list from Excel", "Excel से अपनी सूची अपलोड करें", "Excel मधून तुमची यादी अपलोड करा"),
} as const;

/**
 * Step 8 of the registration — the starter shelf (onboarding Phase B, services/starter-shelf.ts):
 * the products other shops in the chosen categories stock most, already ticked, priced at their
 * MRP and with the default stock (owner, 05-Nov-2026: 100 products × stock 100). The owner
 * unticks what they don't sell, changes a price or a quantity, and publishes them in one go.
 * Phase 2 (WP2): "Scan a barcode" adds a pack from the catalogue to the list, ticked; a code the
 * catalogue does not know becomes a new product for our team to approve (owner, Q9).
 */

interface Item {
  productId: string;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  unit: string;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
}

interface Row {
  ticked: boolean;
  price: string;
  stock: string;
}

const rupees = (paise: number) => (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);

export function StarterShelf({ shopId, onDone, lang = "en" }: { shopId: string; onDone: () => Promise<void>; lang?: Lang }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ productId: string; reason: string }[]>([]);
  const [discount, setDiscount] = useState("0");
  const [defaultStock, setDefaultStock] = useState("100");
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<{ tone: "info" | "success" | "warning" | "danger"; text: string } | null>(null);
  const [unknown, setUnknown] = useState<{ code: string; name: string; unit: string; price: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/shops/${shopId}/starter-shelf`).catch(() => null);
      const payload = await response?.json().catch(() => null);
      if (cancelled) return;
      if (!response?.ok || !payload) {
        setLoadError(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.loadFailed, lang));
        return;
      }
      const list: Item[] = payload.enabled ? payload.items : [];
      setItems(list);
      setDefaultStock(String(payload.defaultStock));
      setRows(
        Object.fromEntries(
          list.map((i) => [
            i.productId,
            // A product with no MRP (loose goods) needs the owner's own price, so it starts unticked.
            { ticked: i.mrpPaise != null, price: i.mrpPaise != null ? rupees(i.mrpPaise) : "", stock: String(payload.defaultStock) },
          ]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, lang]);

  const ticked = useMemo(() => (items ?? []).filter((i) => rows[i.productId]?.ticked), [items, rows]);
  const set = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  /** "x % below MRP" for every ticked product that has an MRP. */
  function applyDiscount() {
    const pct = Math.min(90, Math.max(0, Number(discount) || 0));
    setRows((r) => {
      const next = { ...r };
      for (const i of items ?? []) {
        if (i.mrpPaise != null && next[i.productId]?.ticked) next[i.productId] = { ...next[i.productId], price: rupees(Math.round((i.mrpPaise * (100 - pct)) / 100)) };
      }
      return next;
    });
  }

  async function publish() {
    setError(null);
    const picks = [];
    for (const i of ticked) {
      const row = rows[i.productId];
      const price = Math.round(Number(row.price) * 100);
      const stock = Number(row.stock);
      if (!Number.isFinite(price) || price < 1) return setError(tr(T.enterPrice, lang).replace("{name}", i.name));
      if (i.mrpPaise != null && price > i.mrpPaise)
        return setError(tr(T.aboveMrp, lang).replace("{name}", i.name).replace("{mrp}", `₹${rupees(i.mrpPaise)}`));
      if (!Number.isFinite(stock) || stock < 0) return setError(tr(T.enterQty, lang).replace("{name}", i.name));
      picks.push({ productId: i.productId, pricePaise: price, stock });
    }
    if (picks.length === 0) return setError(tr(T.tickOne, lang));
    setBusy(true);
    const response = await fetch(`/api/shops/${shopId}/starter-shelf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: picks }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok)
      return setError(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.publishFailed, lang));
    setFailed(payload.failed ?? []);
    if ((payload.added ?? 0) > 0) await onDone();
  }

  /** A scanned or typed barcode: the catalogue product goes to the top of the list, ticked. */
  const onCode = useCallback(
    async (code: string) => {
      setScanning(false);
      setScanNote(null);
      setUnknown(null);
      const response = await fetch(`/api/shops/${shopId}/barcode-lookup?code=${encodeURIComponent(code)}`).catch(() => null);
      const payload = await response?.json().catch(() => null);
      if (!response?.ok || !payload)
        return setScanNote({
          tone: "danger",
          text: payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.lookupFailed, lang),
        });
      const match = payload.match as (Item & { approved: boolean; listed: boolean }) | null;
      if (!match) return setUnknown({ code: payload.code, name: "", unit: "piece", price: "" });
      if (match.listed) return setScanNote({ tone: "info", text: tr(T.alreadyIn, lang).replace("{name}", match.name) });
      if (!match.approved) return setScanNote({ tone: "warning", text: tr(T.awaiting, lang).replace("{name}", match.name) });
      setItems((list) => [match, ...(list ?? []).filter((i) => i.productId !== match.productId)]);
      setRows((r) => ({
        ...r,
        [match.productId]: { ticked: match.mrpPaise != null, price: match.mrpPaise != null ? rupees(match.mrpPaise) : "", stock: defaultStock },
      }));
      setScanNote({
        tone: "success",
        text:
          match.mrpPaise != null
            ? tr(T.addedAtMrp, lang).replace("{name}", match.name).replace("{mrp}", `₹${rupees(match.mrpPaise)}`)
            : tr(T.addedSetPrice, lang).replace("{name}", match.name),
      });
    },
    [shopId, defaultStock, lang],
  );

  /** A barcode the catalogue does not know: a new product, on sale once our team approves it. */
  async function addUnknown() {
    if (!unknown) return;
    const price = Math.round(Number(unknown.price) * 100);
    if (unknown.name.trim().length < 2) return setScanNote({ tone: "danger", text: tr(T.enterName, lang) });
    if (!Number.isFinite(price) || price < 1) return setScanNote({ tone: "danger", text: tr(T.enterSelling, lang) });
    const response = await fetch("/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shopId,
        name: unknown.name.trim(),
        unit: unknown.unit,
        barcode: unknown.code,
        onlinePricePaise: price,
        offlinePricePaise: price,
        onlineSaleEnabled: true,
        offlineSaleEnabled: true,
        confirmDuplicate: true,
      }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (!response?.ok)
      return setScanNote({
        tone: "danger",
        text: payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.addFailed, lang),
      });
    setUnknown(null);
    setScanNote({ tone: "success", text: tr(T.sentToTeam, lang) });
  }

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!items) return <p className="text-sm text-ink-600">{tr(T.finding, lang)}</p>;

  const scan = (
    <div className="space-y-2">
      {scanning ? (
        <BarcodeScanner onCode={(code) => void onCode(code)} onClose={() => setScanning(false)} />
      ) : (
        <Button type="button" variant="secondary" className="w-full" onClick={() => setScanning(true)} data-testid="shelf-scan">
          {tr(T.scan, lang)}
        </Button>
      )}
      {scanNote ? (
        <div role={scanNote.tone === "danger" ? "alert" : "status"}>
          <Alert tone={scanNote.tone}>{scanNote.text}</Alert>
        </div>
      ) : null}
      {unknown ? (
        <div className="space-y-2 rounded-xl border border-[var(--gk-line)] bg-cream-50 p-3" data-testid="shelf-new-product">
          <p className="text-sm text-ink-700">
            <strong>{unknown.code}</strong> {tr(T.notInCatalogue, lang)}
          </p>
          <input className={inputClass} placeholder={tr(T.namePlaceholder, lang)} value={unknown.name} onChange={(e) => setUnknown({ ...unknown, name: e.target.value })} aria-label={tr(T.productName, lang)} />
          <div className="grid grid-cols-2 gap-2">
            <select className={inputClass} value={unknown.unit} onChange={(e) => setUnknown({ ...unknown, unit: e.target.value })} aria-label={tr(T.unit, lang)}>
              {PRODUCT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <input className={inputClass} inputMode="decimal" placeholder={tr(T.pricePlaceholder, lang)} value={unknown.price} onChange={(e) => setUnknown({ ...unknown, price: e.target.value })} aria-label={tr(T.sellingPrice, lang)} />
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={() => void addUnknown()}>
              {tr(T.addProduct, lang)}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setUnknown(null)}>
              {tr(T.cancel, lang)}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (items.length === 0) return scan;

  return (
    <div className="space-y-3" data-testid="starter-shelf">
      {scan}
      <p className="text-sm text-ink-700">
        <strong>{ticked.length}</strong> {tr(T.tickedOf, lang).replace("{total}", String(items.length))}
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-cream-50 p-2">
        <label className="text-sm text-ink-700">
          {tr(T.priceForAll, lang)}
          <input className={`${inputClass} mt-1 w-24`} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-label={tr(T.percentBelow, lang)} />
        </label>
        <Button type="button" variant="secondary" onClick={applyDiscount}>
          {tr(T.apply, lang)}
        </Button>
      </div>
      <ul className="max-h-[28rem] divide-y divide-cream-100 overflow-y-auto rounded-xl border border-[var(--gk-line)] bg-white">
        {items.map((i) => {
          const row = rows[i.productId];
          const why = failed.find((f) => f.productId === i.productId)?.reason;
          return (
            <li key={i.productId} className="grid grid-cols-2 items-end gap-2 p-2 sm:grid-cols-[1fr_7rem_6rem]" data-testid={`shelf-${i.productId}`}>
              <label className="col-span-2 flex min-h-11 min-w-0 items-center gap-2 text-sm sm:col-span-1">
                <input type="checkbox" className="h-5 w-5 shrink-0" checked={row?.ticked ?? false} onChange={(e) => set(i.productId, { ticked: e.target.checked })} />
                {i.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- product-master images come from several hosts
                  <img src={i.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" />
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-900">{i.name}</span>
                  <span className="block text-xs text-ink-500">
                    {i.categoryName}
                    {i.mrpPaise != null ? tr(T.mrp, lang).replace("{mrp}", `₹${rupees(i.mrpPaise)}`) : tr(T.loose, lang)}
                  </span>
                </span>
              </label>
              <label className="text-xs text-ink-600">
                {tr(T.price, lang)}
                <input
                  className={`${inputClass} mt-0.5 w-full`}
                  inputMode="decimal"
                  value={row?.price ?? ""}
                  onChange={(e) => set(i.productId, { price: e.target.value, ticked: true })}
                  aria-label={tr(T.priceOf, lang).replace("{name}", i.name)}
                />
              </label>
              <label className="text-xs text-ink-600">
                {tr(T.qty, lang)} ({i.unit})
                <input
                  className={`${inputClass} mt-0.5 w-full`}
                  inputMode="decimal"
                  value={row?.stock ?? ""}
                  onChange={(e) => set(i.productId, { stock: e.target.value })}
                  aria-label={tr(T.qtyOf, lang).replace("{name}", i.name)}
                />
              </label>
              {why ? <p className="col-span-2 text-xs text-red-700 sm:col-span-3">{why}</p> : null}
            </li>
          );
        })}
      </ul>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" size="lg" className="w-full" disabled={busy || ticked.length === 0} onClick={() => void publish()} data-testid="starter-shelf-publish">
        {busy ? tr(T.publishing, lang) : tr(T.publish, lang).replace("{n}", String(ticked.length))}
      </Button>
      <p className="text-center text-sm text-ink-600">
        {tr(T.or, lang)}{" "}
        <Link href="/shop/product-import" className="font-medium text-kesari-700 underline">
          {tr(T.upload, lang)}
        </Link>
      </p>
    </div>
  );
}
