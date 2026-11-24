"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { paiseToRupees } from "@/lib/money";
import { parsePriceInput } from "@/lib/price-rules";
import { FillText } from "@/components/board/fill-text";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi for the stock screen (English unchanged). */
const T = {
  inStock: L("In stock", "स्टॉक में", "स्टॉकमध्ये"),
  low: L("Low", "कम", "कमी"),
  outOfStock: L("Out of stock", "स्टॉक खत्म", "स्टॉक संपला"),
  srcListing: L("this product", "यह उत्पाद", "हे उत्पादन"),
  srcProduct: L("product default", "उत्पाद का डिफ़ॉल्ट", "उत्पादनाचे डीफॉल्ट"),
  srcShop: L("shop default", "दुकान का डिफ़ॉल्ट", "दुकानाचे डीफॉल्ट"),
  srcNone: L("not set", "तय नहीं", "ठरवलेले नाही"),
  sortName: L("Name (A–Z)", "नाम (A–Z)", "नाव (A–Z)"),
  sortAvailAsc: L("Available: lowest first", "उपलब्ध: सबसे कम पहले", "उपलब्ध: सर्वात कमी आधी"),
  sortAvailDesc: L("Available: highest first", "उपलब्ध: सबसे ज़्यादा पहले", "उपलब्ध: सर्वात जास्त आधी"),
  sortPriceAsc: L("Price: lowest first", "कीमत: सबसे कम पहले", "किंमत: सर्वात कमी आधी"),
  sortPriceDesc: L("Price: highest first", "कीमत: सबसे ज़्यादा पहले", "किंमत: सर्वात जास्त आधी"),
  sortStatus: L("Status: out of stock first", "स्थिति: स्टॉक खत्म वाले पहले", "स्थिती: स्टॉक संपलेले आधी"),
  pricesInvalid: L("Some prices are not valid — nothing was saved.", "कुछ कीमतें सही नहीं हैं — कुछ भी सहेजा नहीं गया।", "काही किमती चुकीच्या आहेत — काहीही जतन झाले नाही."),
  noPriceChange: L("No prices were changed.", "कोई कीमत नहीं बदली गई।", "कोणतीही किंमत बदलली नाही."),
  pricesFailed: L("Could not save the prices. Nothing was changed.", "कीमतें सहेजी नहीं जा सकीं। कुछ नहीं बदला।", "किमती जतन करता आल्या नाहीत. काहीही बदलले नाही."),
  savedOne: L("Saved 1 price.", "1 कीमत सहेजी गई।", "1 किंमत जतन केली."),
  savedMany: L("Saved {n} prices.", "{n} कीमतें सहेजी गईं।", "{n} किमती जतन केल्या."),
  didNotWork: L("That did not work.", "यह नहीं हो सका।", "हे झाले नाही."),
  products: L("Products", "उत्पाद", "उत्पादने"),
  needReorder: L("Need reorder", "दोबारा मँगाना है", "पुन्हा मागवायचे"),
  stockValue: L("Stock value at your selling prices: {amount}", "आपकी बिक्री कीमत पर स्टॉक का मूल्य: {amount}", "तुमच्या विक्री किमतीवर स्टॉकचे मूल्य: {amount}"),
  openAlerts: L("Open alerts ({n})", "खुले अलर्ट ({n})", "उघड्या सूचना ({n})"),
  product: L("Product", "उत्पाद", "उत्पादन"),
  leftWhenRaised: L("{n} left when raised", "अलर्ट के समय {n} बचे थे", "सूचनेच्या वेळी {n} शिल्लक होते"),
  acknowledge: L("Acknowledge", "देख लिया", "पाहिले"),
  defaultsTitle: L("Shop-wide defaults", "पूरी दुकान के डिफ़ॉल्ट", "संपूर्ण दुकानाचे डीफॉल्ट"),
  defaultsHint: L(
    "Used for any product that has no threshold of its own and no product-wide default. Leave a box empty for none.",
    "उन उत्पादों के लिए जिनकी अपनी सीमा या उत्पाद का डिफ़ॉल्ट नहीं है। कुछ नहीं चाहिए तो खाना खाली छोड़ें।",
    "ज्या उत्पादनांना स्वतःची मर्यादा किंवा उत्पादनाचे डीफॉल्ट नाही त्यांच्यासाठी. नको असल्यास रकाना रिकामा ठेवा.",
  ),
  lowThreshold: L("Low-stock threshold", "कम स्टॉक की सीमा", "कमी स्टॉकची मर्यादा"),
  reorderLevel: L("Reorder level", "दोबारा मँगाने का स्तर", "पुन्हा मागवण्याची पातळी"),
  reorderQty: L("Reorder quantity", "दोबारा मँगाने की मात्रा", "पुन्हा मागवण्याचे प्रमाण"),
  saveDefaults: L("Save defaults", "डिफ़ॉल्ट सहेजें", "डीफॉल्ट जतन करा"),
  stockByProduct: L("Stock by product", "उत्पाद के अनुसार स्टॉक", "उत्पादनानुसार स्टॉक"),
  showAll: L("Show all products", "सभी उत्पाद दिखाएँ", "सर्व उत्पादने दाखवा"),
  needsPriceN: L("Needs a price ({n})", "कीमत चाहिए ({n})", "किंमत हवी ({n})"),
  savePrices: L("Save prices", "कीमतें सहेजें", "किमती जतन करा"),
  searchAria: L("Search products", "उत्पाद खोजें", "उत्पादने शोधा"),
  searchPh: L("Search by name or code", "नाम या कोड से खोजें", "नाव किंवा कोडने शोधा"),
  category: L("Category", "श्रेणी", "श्रेणी"),
  allCategories: L("All categories", "सभी श्रेणियाँ", "सर्व श्रेणी"),
  lowStock: L("Low stock", "कम स्टॉक", "कमी स्टॉक"),
  sort: L("Sort", "क्रम", "क्रम"),
  showing: L("Showing {n} of {total}", "{total} में से {n} दिख रहे हैं", "{total} पैकी {n} दिसत आहेत"),
  tableAria: L("Inventory table", "इन्वेंटरी तालिका", "इन्व्हेंटरी तक्ता"),
  unit: L("Unit", "इकाई", "एकक"),
  available: L("Available", "उपलब्ध", "उपलब्ध"),
  price: L("Price (₹)", "कीमत (₹)", "किंमत (₹)"),
  reserved: L("Reserved", "आरक्षित", "राखीव"),
  onHand: L("On hand", "हाथ में", "हातात"),
  lowAt: L("Low at", "कम माना जाएगा", "कमी मानले जाईल"),
  reorderAt: L("Reorder at", "दोबारा मँगाएँ", "पुन्हा मागवा"),
  status: L("Status", "स्थिति", "स्थिती"),
  noMatch: L("No products match these filters.", "इन फ़िल्टर से कोई उत्पाद मेल नहीं खाता।", "या फिल्टरशी कोणतेही उत्पादन जुळत नाही."),
  lowInherit: L("Low-stock threshold (0 = inherit)", "कम स्टॉक की सीमा (0 = डिफ़ॉल्ट)", "कमी स्टॉकची मर्यादा (0 = डीफॉल्ट)"),
  levelInherit: L("Reorder level (empty = inherit)", "दोबारा मँगाने का स्तर (खाली = डिफ़ॉल्ट)", "पुन्हा मागवण्याची पातळी (रिकामे = डीफॉल्ट)"),
  noAlerts: L("No stock alerts for this product", "इस उत्पाद के लिए स्टॉक अलर्ट नहीं", "या उत्पादनासाठी स्टॉक सूचना नको"),
  save: L("Save", "सहेजें", "जतन करा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  priceOf: L("Price of {name}", "{name} की कीमत", "{name} ची किंमत"),
  enterPrice: L("Enter price", "कीमत लिखें", "किंमत लिहा"),
  needsPrice: L("Needs a price", "कीमत चाहिए", "किंमत हवी"),
  off: L("off", "बंद", "बंद"),
  order: L("order {n}", "{n} मँगाएँ", "{n} मागवा"),
  reorder: L("reorder", "दोबारा मँगाएँ", "पुन्हा मागवा"),
  thresholds: L("Thresholds", "सीमाएँ", "मर्यादा"),
  footnote: L(
    "{available} can be sold now; {reserved} is committed to orders not yet delivered; {onHand} is both together. Alerts compare {availableEm} stock with your thresholds.",
    "{available} अभी बेचा जा सकता है; {reserved} उन ऑर्डर के लिए रखा है जो अभी डिलीवर नहीं हुए; {onHand} दोनों मिलाकर है। अलर्ट {availableEm} स्टॉक की तुलना आपकी सीमाओं से करते हैं।",
    "{available} आता विकता येतो; {reserved} न पोहोचलेल्या ऑर्डरसाठी ठेवलेला आहे; {onHand} म्हणजे दोन्ही मिळून. सूचना {availableEm} स्टॉकची तुलना तुमच्या मर्यादांशी करतात.",
  ),
  fAvailable: L("Available", "उपलब्ध", "उपलब्ध"),
  fReserved: L("reserved", "आरक्षित", "राखीव"),
  fOnHand: L("on hand", "हाथ में", "हातात"),
  fAvailableEm: L("available", "उपलब्ध", "उपलब्ध"),
} as const satisfies Record<string, Text>;

export interface InventoryRowView {
  shopProductId: string;
  productCode: string;
  productName: string;
  categoryName: string | null;
  unit: string;
  /** The shop's own prices; both null until the owner sets one. */
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  available: number;
  reserved: number;
  onHand: number;
  status: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
  reorderNeeded: boolean;
  thresholds: {
    lowStock: number;
    reorderLevel: number | null;
    reorderQuantity: number | null;
    source: { lowStock: string; reorderLevel: string; reorderQuantity: string };
    alertsDisabled: boolean;
  };
  own: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null; stockAlertsDisabled: boolean };
  openAlerts: string[];
}

export interface InventoryView {
  dashboard: { totalProducts: number; inStock: number; lowStock: number; outOfStock: number; reorderRequired: number; inventoryValuePaise: number };
  rows: InventoryRowView[];
  alerts: { id: string; shopProductId: string; alertType: string; stockAtAlert: number }[];
  shopDefaults: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null };
}

const STATUS_TONE = { IN_STOCK: "success", LOW_STOCK: "warning", OUT_OF_STOCK: "danger" } as const;
const STATUS_LABEL = { IN_STOCK: T.inStock, LOW_STOCK: T.low, OUT_OF_STOCK: T.outOfStock } as const;
const SOURCE_LABEL: Record<string, Text> = { LISTING: T.srcListing, PRODUCT: T.srcProduct, SHOP: T.srcShop, NONE: T.srcNone };

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** D-96: how the stock table can be ordered. */
const SORTS = {
  name: T.sortName,
  "available-asc": T.sortAvailAsc,
  "available-desc": T.sortAvailDesc,
  "price-asc": T.sortPriceAsc,
  "price-desc": T.sortPriceDesc,
  status: T.sortStatus,
} as const;
type SortKey = keyof typeof SORTS;
const STATUS_ORDER = { OUT_OF_STOCK: 0, LOW_STOCK: 1, IN_STOCK: 2 } as const;
const selectClass = inputClass.replace("w-full ", "");

/** Stock levels, thresholds at shop / product / listing level, and open alerts for a shop. */
export function ShopInventoryManager({ shopId, view, lang = "en" }: { shopId: string; view: InventoryView; /** Module 6: board language. */ lang?: Lang }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState({
    low: String(view.shopDefaults.lowStockThreshold),
    level: view.shopDefaults.reorderLevel != null ? String(view.shopDefaults.reorderLevel) : "",
    qty: view.shopDefaults.reorderQuantity != null ? String(view.shopDefaults.reorderQuantity) : "",
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ low: "", level: "", qty: "", off: false });
  // Prices typed in the table, by listing, until "Save prices" sends them.
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [priceMessage, setPriceMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [needsPriceOnly, setNeedsPriceOnly] = useState(false);
  // D-96: search, category, stock filters and sort for the stock table.
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [outOnly, setOutOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");

  // The price shown and edited: online, else the in-shop one. Null means none set yet.
  const priceOf = (r: InventoryRowView) => r.onlinePricePaise ?? r.offlinePricePaise;
  const needsPriceCount = view.rows.filter((r) => priceOf(r) == null).length;
  const categories = useMemo(
    () => [...new Set(view.rows.map((r) => r.categoryName).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [view.rows],
  );
  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = view.rows.filter(
      (r) =>
        (!needsPriceOnly || priceOf(r) == null) &&
        (!q || r.productName.toLowerCase().includes(q) || r.productCode.toLowerCase().includes(q)) &&
        (!category || r.categoryName === category) &&
        // Both ticked: low or out of stock.
        (!(lowOnly || outOnly) || (lowOnly && r.status === "LOW_STOCK") || (outOnly && r.status === "OUT_OF_STOCK")),
    );
    // Products without a price go last when sorting by price.
    const price = (r: InventoryRowView, empty: number) => priceOf(r) ?? empty;
    const byName = (a: InventoryRowView, b: InventoryRowView) => a.productName.localeCompare(b.productName);
    const compare: Record<SortKey, (a: InventoryRowView, b: InventoryRowView) => number> = {
      name: byName,
      "available-asc": (a, b) => a.available - b.available || byName(a, b),
      "available-desc": (a, b) => b.available - a.available || byName(a, b),
      "price-asc": (a, b) => price(a, Infinity) - price(b, Infinity) || byName(a, b),
      "price-desc": (a, b) => price(b, -Infinity) - price(a, -Infinity) || byName(a, b),
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.available - b.available || byName(a, b),
    };
    return [...rows].sort(compare[sort]);
  }, [view.rows, needsPriceOnly, query, category, lowOnly, outOnly, sort]);
  const filtered = shownRows.length !== view.rows.length;

  async function savePrices() {
    setPriceMessage(null);
    const errors: Record<string, string> = {};
    const prices: { shopProductId: string; pricePaise: number }[] = [];
    for (const [shopProductId, raw] of Object.entries(priceEdits)) {
      const row = view.rows.find((r) => r.shopProductId === shopProductId);
      if (!row) continue;
      const value = raw.trim();
      // An empty box is not a change: a price cannot be removed here.
      if (value === "") continue;
      // More than 2 decimals is refused, not rounded: "10.555" was saved as 1056 paise (TC-CAT-032).
      const parsed = parsePriceInput(value);
      if (!parsed.ok) {
        errors[shopProductId] = errorText(parsed.error, lang);
        continue;
      }
      const pricePaise = parsed.paise;
      if (pricePaise !== row.onlinePricePaise || pricePaise !== row.offlinePricePaise) {
        prices.push({ shopProductId, pricePaise });
      }
    }
    setPriceErrors(errors);
    if (Object.keys(errors).length > 0) {
      setPriceMessage({ tone: "danger", text: tr(T.pricesInvalid, lang) });
      return;
    }
    if (prices.length === 0) {
      setPriceMessage({ tone: "danger", text: tr(T.noPriceChange, lang) });
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/shops/${shopId}/prices`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices }),
    }).catch(() => null);
    const payload = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (!res?.ok) {
      setPriceMessage({ tone: "danger", text: errorText(payload?.error?.message ?? tr(T.pricesFailed, lang), lang, payload?.error?.code) });
      return;
    }
    setPriceEdits({});
    setPriceMessage({ tone: "success", text: prices.length === 1 ? tr(T.savedOne, lang) : tr(T.savedMany, lang).replace("{n}", String(prices.length)) });
    router.refresh();
  }

  async function call(url: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(errorText(payload?.error?.message ?? tr(T.didNotWork, lang), lang, payload?.error?.code));
      return false;
    }
    router.refresh();
    return true;
  }

  const d = view.dashboard;
  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-5" data-testid="inventory-summary">
        {[
          [tr(T.products, lang), d.totalProducts],
          [tr(T.inStock, lang), d.inStock],
          [tr(T.low, lang), d.lowStock],
          [tr(T.outOfStock, lang), d.outOfStock],
          [tr(T.needReorder, lang), d.reorderRequired],
        ].map(([label, n]) => (
          <Card key={label as string} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
            <p className="text-2xl font-semibold text-ink-900">{n}</p>
          </Card>
        ))}
      </div>
      <p className="-mt-4 text-sm text-ink-500">
        <FillText text={tr(T.stockValue, lang)} parts={{ amount: <Money paise={d.inventoryValuePaise} /> }} />
      </p>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {view.alerts.length > 0 ? (
        <section id="alerts" className="scroll-mt-20">
          <h2 className="mb-2 text-lg font-semibold text-ink-900">{tr(T.openAlerts, lang).replace("{n}", String(view.alerts.length))}</h2>
          <Card className="divide-y divide-cream-100">
            {view.alerts.map((a) => {
              const row = view.rows.find((r) => r.shopProductId === a.shopProductId);
              return (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <Badge tone={a.alertType === "OUT_OF_STOCK" ? "danger" : "warning"}>{a.alertType.replace(/_/g, " ").toLowerCase()}</Badge>{" "}
                    {row?.productName ?? tr(T.product, lang)} — {tr(T.leftWhenRaised, lang).replace("{n}", String(a.stockAtAlert))}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await fetch(`/api/stock-alerts/${a.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "acknowledge" }),
                      });
                      setBusy(false);
                      router.refresh();
                    }}
                  >
                    {tr(T.acknowledge, lang)}
                  </Button>
                </div>
              );
            })}
          </Card>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">{tr(T.defaultsTitle, lang)}</h2>
        <Card className="space-y-3 p-4">
          <p className="text-sm text-ink-500">
            {tr(T.defaultsHint, lang)}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tr(T.lowThreshold, lang)}>
              <input className={inputClass} inputMode="numeric" value={defaults.low} onChange={(e) => setDefaults({ ...defaults, low: e.target.value })} />
            </Field>
            <Field label={tr(T.reorderLevel, lang)}>
              <input className={inputClass} inputMode="numeric" value={defaults.level} onChange={(e) => setDefaults({ ...defaults, level: e.target.value })} />
            </Field>
            <Field label={tr(T.reorderQty, lang)}>
              <input className={inputClass} inputMode="numeric" value={defaults.qty} onChange={(e) => setDefaults({ ...defaults, qty: e.target.value })} />
            </Field>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              call(`/api/shops/${shopId}/inventory`, {
                lowStockThreshold: num(defaults.low) ?? 0,
                reorderLevel: num(defaults.level),
                reorderQuantity: num(defaults.qty),
              })
            }
          >
            {tr(T.saveDefaults, lang)}
          </Button>
        </Card>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">{tr(T.stockByProduct, lang)}</h2>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setNeedsPriceOnly((v) => !v)}>
              {needsPriceOnly ? tr(T.showAll, lang) : tr(T.needsPriceN, lang).replace("{n}", String(needsPriceCount))}
            </Button>
            <Button size="sm" disabled={busy} onClick={savePrices}>
              {tr(T.savePrices, lang)}
            </Button>
          </div>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="inventory-filters">
          <input
            type="search"
            aria-label={tr(T.searchAria, lang)}
            placeholder={tr(T.searchPh, lang)}
            className={`${inputClass} w-full sm:w-56`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label={tr(T.category, lang)} className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{tr(T.allCategories, lang)}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="flex min-h-10 items-center gap-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> {tr(T.lowStock, lang)}
          </label>
          <label className="flex min-h-10 items-center gap-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={outOnly} onChange={(e) => setOutOnly(e.target.checked)} /> {tr(T.outOfStock, lang)}
          </label>
          <select aria-label={tr(T.sort, lang)} className={selectClass} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {tr(SORTS[k], lang)}
              </option>
            ))}
          </select>
          {filtered ? (
            <span className="text-xs text-ink-500" data-testid="inventory-shown-count">
              {tr(T.showing, lang).replace("{n}", String(shownRows.length)).replace("{total}", String(view.rows.length))}
            </span>
          ) : null}
        </div>
        {priceMessage ? (
          <div className="mb-2">
            <Alert tone={priceMessage.tone}>{priceMessage.text}</Alert>
          </div>
        ) : null}
        {/* D-146: a keyboard user can focus the table and scroll it sideways with the arrow keys. */}
        <Card className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-kesari-600" tabIndex={0} role="region" aria-label={tr(T.tableAria, lang)}>
          <table className="w-full text-left text-sm" data-testid="inventory-table">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">{tr(T.product, lang)}</th>
                <th className="px-3 py-2">{tr(T.unit, lang)}</th>
                <th className="px-3 py-2">{tr(T.available, lang)}</th>
                <th className="px-3 py-2">{tr(T.price, lang)}</th>
                <th className="px-3 py-2">{tr(T.reserved, lang)}</th>
                <th className="px-3 py-2">{tr(T.onHand, lang)}</th>
                <th className="px-3 py-2">{tr(T.lowAt, lang)}</th>
                <th className="px-3 py-2">{tr(T.reorderAt, lang)}</th>
                <th className="px-3 py-2">{tr(T.status, lang)}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {shownRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-ink-500">
                    {tr(T.noMatch, lang)}
                  </td>
                </tr>
              ) : null}
              {shownRows.map((r) => (
                <tr key={r.shopProductId} className="align-top">
                  <td className="px-3 py-2">
                    {r.productName} <span className="text-xs text-ink-500">{r.productCode}</span>
                    {editing === r.shopProductId ? (
                      <div className="mt-2 space-y-2 rounded-lg border border-cream-200 p-3">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <Field label={tr(T.lowInherit, lang)}>
                            <input className={inputClass} inputMode="numeric" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })} />
                          </Field>
                          <Field label={tr(T.levelInherit, lang)}>
                            <input className={inputClass} inputMode="numeric" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />
                          </Field>
                          <Field label={tr(T.reorderQty, lang)}>
                            <input className={inputClass} inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
                          </Field>
                        </div>
                        <label className="flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={form.off} onChange={(e) => setForm({ ...form, off: e.target.checked })} /> {tr(T.noAlerts, lang)}
                        </label>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await call(`/api/shop-products/${r.shopProductId}/stock-settings`, {
                                lowStockThreshold: num(form.low) ?? 0,
                                reorderLevel: num(form.level),
                                reorderQuantity: num(form.qty),
                                stockAlertsDisabled: form.off,
                              });
                              if (ok) setEditing(null);
                            }}
                          >
                            {tr(T.save, lang)}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            {tr(T.cancel, lang)}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{r.unit}</td>
                  <td className="px-3 py-2 font-medium">{r.available}</td>
                  <td className="px-3 py-2">
                    <input
                      aria-label={tr(T.priceOf, lang).replace("{name}", r.productName)}
                      className={`${inputClass} min-w-24`}
                      inputMode="decimal"
                      placeholder={tr(T.enterPrice, lang)}
                      value={
                        priceEdits[r.shopProductId] ??
                        (priceOf(r) != null ? String(paiseToRupees(priceOf(r)!)) : "")
                      }
                      onChange={(e) => setPriceEdits({ ...priceEdits, [r.shopProductId]: e.target.value })}
                    />
                    {priceErrors[r.shopProductId] ? (
                      <span className="mt-1 block text-xs text-red-600">{priceErrors[r.shopProductId]}</span>
                    ) : priceOf(r) == null ? (
                      <span className="mt-1 block whitespace-nowrap text-xs text-ink-500">{tr(T.needsPrice, lang)}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{r.reserved}</td>
                  <td className="px-3 py-2">{r.onHand}</td>
                  <td className="px-3 py-2">
                    {r.thresholds.alertsDisabled ? tr(T.off, lang) : r.thresholds.lowStock || "—"}
                    <span className="block text-xs text-ink-500">{r.thresholds.alertsDisabled ? "" : SOURCE_LABEL[r.thresholds.source.lowStock] ? tr(SOURCE_LABEL[r.thresholds.source.lowStock], lang) : undefined}</span>
                  </td>
                  <td className="px-3 py-2">
                    {r.thresholds.reorderLevel ?? "—"}
                    {r.thresholds.reorderQuantity ? <span className="block text-xs text-ink-500">{tr(T.order, lang).replace("{n}", String(r.thresholds.reorderQuantity))}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[r.status]}>{tr(STATUS_LABEL[r.status], lang)}</Badge>
                    {r.reorderNeeded ? <Badge tone="warning">{tr(T.reorder, lang)}</Badge> : null}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-xs font-medium text-kesari-700 underline"
                      onClick={() => {
                        setEditing(r.shopProductId);
                        setForm({
                          low: String(r.own.lowStockThreshold),
                          level: r.own.reorderLevel != null ? String(r.own.reorderLevel) : "",
                          qty: r.own.reorderQuantity != null ? String(r.own.reorderQuantity) : "",
                          off: r.own.stockAlertsDisabled,
                        });
                      }}
                    >
                      {tr(T.thresholds, lang)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-xs text-ink-500">
          <FillText
            text={tr(T.footnote, lang)}
            parts={{
              available: <strong>{tr(T.fAvailable, lang)}</strong>,
              reserved: <strong>{tr(T.fReserved, lang)}</strong>,
              onHand: <strong>{tr(T.fOnHand, lang)}</strong>,
              availableEm: <em>{tr(T.fAvailableEm, lang)}</em>,
            }}
          />
        </p>
      </section>
    </div>
  );
}
