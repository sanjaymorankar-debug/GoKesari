"use client";

/**
 * Wishlist review (docs/smart-shopping-2026-11, Feature 1 §3): every item as an editable row —
 * original text | English | local language | matched product | qty | unit. Low-confidence matches are
 * highlighted; the customer can change the product, edit qty/unit, delete, or add an item by hand.
 * Used for a fresh scan (unsaved) and for a saved wishlist.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { tr, type Lang } from "@/lib/board/i18n";
import type { BaseUnit } from "@/lib/qty-words";
import { type MatchCandidate, QUANTITY_UNIT_LABELS, QUANTITY_UNITS } from "@/lib/smart-list";

export interface EditorItem {
  key: string;
  originalText: string | null;
  originalLang: string | null;
  nameEn: string;
  nameLocal: string | null;
  productId: string | null;
  productName: string | null;
  aiProductId: string | null;
  matchConfidence: number | null;
  candidates: MatchCandidate[];
  quantityAmount: number;
  quantityUnit: BaseUnit;
  userEdited: boolean;
  status?: string;
}

const T = {
  original: { en: "Written", hi: "लिखा हुआ", mr: "लिहिलेले" },
  english: { en: "English", hi: "अंग्रेज़ी", mr: "इंग्रजी" },
  local: { en: "Your language", hi: "आपकी भाषा", mr: "तुमची भाषा" },
  product: { en: "Product", hi: "उत्पाद", mr: "उत्पादन" },
  qty: { en: "Qty", hi: "मात्रा", mr: "प्रमाण" },
  check: { en: "Please check", hi: "कृपया जाँचें", mr: "कृपया तपासा" },
  noMatch: { en: "Not found in catalogue — choose a product", hi: "कैटलॉग में नहीं मिला — उत्पाद चुनें", mr: "कॅटलॉगमध्ये सापडले नाही — उत्पादन निवडा" },
  change: { en: "Change", hi: "बदलें", mr: "बदला" },
  remove: { en: "Remove", hi: "हटाएँ", mr: "काढा" },
  add: { en: "+ Add an item", hi: "+ आइटम जोड़ें", mr: "+ वस्तू जोडा" },
  search: { en: "Type a product name…", hi: "उत्पाद का नाम लिखें…", mr: "उत्पादनाचे नाव लिहा…" },
  save: { en: "Save wishlist", hi: "विशलिस्ट सेव करें", mr: "विशलिस्ट जतन करा" },
  saveCompare: { en: "Save & compare shop prices", hi: "सेव करें और दाम मिलाएँ", mr: "जतन करा आणि दर तुलना करा" },
  name: { en: "List name", hi: "सूची का नाम", mr: "यादीचे नाव" },
  confidence: { en: "match", hi: "मेल", mr: "जुळणी" },
};

function Picker({ lang, onPick }: { lang: Lang; onPick: (c: MatchCandidate) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MatchCandidate[]>([]);
  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) return setResults([]);
    const res = await fetch(`/api/smart-list/products?q=${encodeURIComponent(text.trim())}`);
    if (res.ok) setResults((await res.json()).products ?? []);
  }
  return (
    <div className="mt-2 rounded-xl border border-[var(--gk-line)] bg-white p-2">
      <input value={q} onChange={(e) => void search(e.target.value)} placeholder={tr(T.search, lang)} className="h-11 w-full rounded-lg border px-3" autoFocus />
      <ul className="mt-1 max-h-56 overflow-auto">
        {results.map((c) => (
          <li key={c.productId}>
            <button type="button" onClick={() => onPick(c)} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2 text-left hover:bg-kesari-50">
              <span>
                {c.name}
                {c.brand ? <span className="text-ink-500"> · {c.brand}</span> : null}
              </span>
              <span className="text-xs text-ink-500">{c.unit}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WishlistEditor({
  lang,
  initial,
  lowConfidenceBelow,
  scanId,
  wishlistId,
  initialName,
}: {
  lang: Lang;
  initial: EditorItem[];
  lowConfidenceBelow: number;
  scanId?: string | null;
  wishlistId?: string;
  initialName?: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState<EditorItem[]>(initial);
  const [name, setName] = useState(initialName ?? "");
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: string, patch: Partial<EditorItem>) {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch, userEdited: true } : i)));
  }

  function addItem() {
    const key = `new-${Date.now()}`;
    setItems((all) => [
      ...all,
      { key, originalText: null, originalLang: null, nameEn: "", nameLocal: null, productId: null, productName: null, aiProductId: null, matchConfidence: null, candidates: [], quantityAmount: 1, quantityUnit: "piece", userEdited: true },
    ]);
    setPicking(key);
  }

  async function save(thenCompare: boolean) {
    setBusy(true);
    setError(null);
    const payload = {
      name: name || undefined,
      scanId: scanId ?? null,
      items: items
        .filter((i) => i.nameEn.trim() || i.productName)
        .map((i) => ({
          originalText: i.originalText,
          originalLang: i.originalLang,
          nameEn: (i.nameEn || i.productName || "").slice(0, 120),
          nameLocal: i.nameLocal,
          productId: i.productId,
          aiProductId: i.aiProductId,
          matchConfidence: i.matchConfidence,
          quantityAmount: i.quantityAmount,
          quantityUnit: i.quantityUnit,
          userEdited: i.userEdited,
        })),
    };
    const res = await fetch(wishlistId ? `/api/smart-list/wishlists/${wishlistId}` : "/api/smart-list/wishlists", {
      method: wishlistId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error?.message ?? "Could not save. Try again.");
      return;
    }
    const id = wishlistId ?? (await res.json()).id;
    router.push(thenCompare ? `/wishlist/${id}/compare` : `/wishlist/${id}`);
    router.refresh();
  }

  return (
    <div className="space-y-3" data-testid="wishlist-editor">
      <label className="block text-sm font-semibold">
        {tr(T.name, lang)}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="mt-1 h-11 w-full rounded-xl border px-3" />
      </label>
      <ul className="space-y-2">
        {items.map((item) => {
          const low = item.productId == null || (item.matchConfidence != null && item.matchConfidence < lowConfidenceBelow && !item.userEdited);
          return (
            <li
              key={item.key}
              data-testid="wishlist-row"
              data-low={low ? "1" : "0"}
              className={`rounded-2xl border-2 bg-white p-3 ${low ? "border-amber-400 bg-amber-50" : "border-[var(--gk-line)]"}`}
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr]">
                <div className="text-sm">
                  <div className="text-xs font-semibold uppercase text-ink-500">{tr(T.original, lang)}</div>
                  <div className="font-medium">{item.originalText ?? "—"}</div>
                </div>
                <label className="text-sm">
                  <span className="text-xs font-semibold uppercase text-ink-500">{tr(T.english, lang)}</span>
                  <input value={item.nameEn} onChange={(e) => update(item.key, { nameEn: e.target.value })} className="mt-0.5 h-10 w-full rounded-lg border px-2" />
                </label>
                <label className="text-sm">
                  <span className="text-xs font-semibold uppercase text-ink-500">{tr(T.local, lang)}</span>
                  <input value={item.nameLocal ?? ""} onChange={(e) => update(item.key, { nameLocal: e.target.value })} className="mt-0.5 h-10 w-full rounded-lg border px-2" />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="text-xs font-semibold uppercase text-ink-500">{tr(T.product, lang)}: </span>
                  {item.productName ? <strong>{item.productName}</strong> : <span className="text-amber-800">{tr(T.noMatch, lang)}</span>}
                  {item.matchConfidence != null && item.productId ? (
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold ${low ? "bg-amber-200 text-amber-900" : "bg-leaf-50 text-leaf-800"}`}>
                      {item.matchConfidence}% {tr(T.confidence, lang)}
                      {low ? ` · ${tr(T.check, lang)}` : ""}
                    </span>
                  ) : null}
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.001}
                  step="any"
                  aria-label={tr(T.qty, lang)}
                  value={item.quantityAmount}
                  onChange={(e) => update(item.key, { quantityAmount: Math.max(0.001, Number(e.target.value) || 0) })}
                  className="h-11 w-24 rounded-lg border px-2 text-right"
                />
                <select
                  aria-label="unit"
                  value={item.quantityUnit}
                  onChange={(e) => update(item.key, { quantityUnit: e.target.value as BaseUnit })}
                  className="h-11 rounded-lg border px-2"
                >
                  {QUANTITY_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {QUANTITY_UNIT_LABELS[u]}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setPicking(picking === item.key ? null : item.key)} className="h-11 rounded-lg border px-3 text-sm font-semibold">
                  {tr(T.change, lang)}
                </button>
                <button type="button" onClick={() => setItems((all) => all.filter((i) => i.key !== item.key))} className="h-11 rounded-lg border border-red-300 px-3 text-sm font-semibold text-red-700">
                  {tr(T.remove, lang)}
                </button>
              </div>
              {picking === item.key ? (
                <>
                  {item.candidates.length > 1 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.candidates.map((c) => (
                        <button
                          key={c.productId}
                          type="button"
                          onClick={() => {
                            update(item.key, { productId: c.productId, productName: c.name, matchConfidence: null, nameEn: item.nameEn || c.name });
                            setPicking(null);
                          }}
                          className="min-h-10 rounded-full border bg-white px-3 text-sm hover:bg-kesari-50"
                        >
                          {c.name} <span className="text-xs text-ink-500">({c.score}%)</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Picker
                    lang={lang}
                    onPick={(c) => {
                      update(item.key, { productId: c.productId, productName: c.name, matchConfidence: null, nameEn: item.nameEn || c.name });
                      setPicking(null);
                    }}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={addItem} className="h-11 rounded-xl border-2 border-dashed border-kesari-400 px-4 font-semibold text-kesari-800">
        {tr(T.add, lang)}
      </button>
      {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || items.length === 0} onClick={() => void save(true)} className="h-12 rounded-xl bg-kesari-600 px-5 font-bold text-white disabled:opacity-50" data-testid="save-compare">
          {tr(T.saveCompare, lang)}
        </button>
        <button type="button" disabled={busy || items.length === 0} onClick={() => void save(false)} className="h-12 rounded-xl border-2 border-kesari-600 px-5 font-bold text-kesari-800 disabled:opacity-50">
          {tr(T.save, lang)}
        </button>
      </div>
    </div>
  );
}
