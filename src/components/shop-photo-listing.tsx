"use client";

/**
 * Add product by photo + voice (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md).
 *
 * Capture 1–4 photos (front, back, label, barcode) → AI reads them → review every field (low-confidence ones
 * highlighted), say or type price / stock / unit, hear it read back → "Publish to my shop". Bulk mode: shoot
 * the next product straight away and review all waiting products at the end.
 *
 * Voice goes through lib/voice-input (the app's own recogniser inside the Android app, else the browser's Web
 * Speech API); without either, the owner types. There is no server speech-to-text.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import type { Lang } from "@/lib/board/i18n";
import {
  packUnitFromLabel,
  parsePriceStock,
  priceAboveMrp,
  readBack,
  SELLING_UNITS,
  toListingQuantities,
  unitLabel,
  type SellingUnit,
} from "@/lib/price-stock-parse";
import { packInBase } from "@/lib/qty-words";
import { listenOnce, speak, voiceInputAvailable, type VoiceLang } from "@/lib/voice-input";
import type { AiFieldKey, PhotoListingDraftView, PublishResult, SpokenPriceStock } from "@/server/services/shop-photo-listing";

type Side = "FRONT" | "BACK" | "LABEL" | "BARCODE";
const SIDES: Side[] = ["FRONT", "BACK", "LABEL", "BARCODE"];
const VOICE_LANG: Record<Lang, VoiceLang> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

const T = {
  en: {
    capture: "1. Photos of the product", sides: { FRONT: "Front", BACK: "Back", LABEL: "Label", BARCODE: "Barcode" },
    take: "Take / choose photo", remove: "Remove", read: "Read photos", reading: "Reading the photos…",
    waiting: "Waiting for review", reviewAll: "Review", discard: "Discard", next: "Shoot next product (review later)",
    review: "2. Check the details", low: "Please check: AI was not sure", priceStock: "3. Price, stock and unit",
    speakBtn: "🎤 Speak price and stock", listening: "Listening…", typeHint: "Or type, e.g. ₹60 per litre, 50 bottles",
    understand: "Read it", price: "Selling price (₹)", per: "per", stock: "Stock", custom: "Your unit (e.g. bundle)",
    match: "Already in the GoKesari catalogue", useMatch: "Use this product (no duplicate)", newProduct: "Add as a new product instead",
    newNote: "A new product is in your shop at once and is checked by our team before other shops can use it.",
    mrpWarn: "Your price is above the MRP printed on the pack. Lower the price or correct the MRP.",
    publish: "Publish to my shop", publishing: "Publishing…", done: "Published", photosUse: "Photos to show customers",
    dupConfirm: "Create it anyway", noVoice: "Voice input is not available here — please type.", retake: "Retake photos",
    fields: { brand: "Brand", name: "Product name", variant: "Variant / flavour", packSize: "Pack size", packUnit: "Pack unit", mrpRupees: "MRP (₹)", category: "Category", subCategory: "Sub-category", barcode: "Barcode / EAN", fssaiNumber: "FSSAI number", ingredients: "Ingredients / key specs", vegMark: "Veg mark", manufacturer: "Manufacturer", expiry: "Expiry / best before" },
    descEn: "Description (English)", descLocal: "Description (local language)", specsEn: "Specs (English), one per line", specsLocal: "Specs (local language), one per line",
    pending: "Waiting for review", inShop: "Now in your shop",
  },
  hi: {
    capture: "1. उत्पाद की फ़ोटो", sides: { FRONT: "सामने", BACK: "पीछे", LABEL: "लेबल", BARCODE: "बारकोड" },
    take: "फ़ोटो लें / चुनें", remove: "हटाएँ", read: "फ़ोटो पढ़ें", reading: "फ़ोटो पढ़ रहे हैं…",
    waiting: "जाँच के लिए बाकी", reviewAll: "जाँचें", discard: "हटाएँ", next: "अगला उत्पाद (बाद में जाँचें)",
    review: "2. विवरण जाँचें", low: "कृपया जाँचें: AI को पक्का नहीं था", priceStock: "3. कीमत, स्टॉक और यूनिट",
    speakBtn: "🎤 कीमत और स्टॉक बोलें", listening: "सुन रहे हैं…", typeHint: "या लिखें, जैसे ₹60 प्रति लीटर, 50 बोतल",
    understand: "पढ़ें", price: "बिक्री कीमत (₹)", per: "प्रति", stock: "स्टॉक", custom: "आपकी यूनिट (जैसे गड्डी)",
    match: "GoKesari कैटलॉग में पहले से है", useMatch: "यही उत्पाद लें (दोहराव नहीं)", newProduct: "नया उत्पाद जोड़ें",
    newNote: "नया उत्पाद तुरंत आपकी दुकान में दिखेगा; दूसरी दुकानों के लिए हमारी टीम जाँच करेगी।",
    mrpWarn: "आपकी कीमत पैक पर छपी MRP से ज़्यादा है। कीमत कम करें या MRP सुधारें।",
    publish: "मेरी दुकान में प्रकाशित करें", publishing: "प्रकाशित हो रहा है…", done: "प्रकाशित", photosUse: "ग्राहकों को दिखने वाली फ़ोटो",
    dupConfirm: "फिर भी बनाएँ", noVoice: "यहाँ आवाज़ से इनपुट नहीं है — कृपया लिखें।", retake: "फ़ोटो दोबारा लें",
    fields: { brand: "ब्रांड", name: "उत्पाद का नाम", variant: "वैरिएंट / स्वाद", packSize: "पैक साइज़", packUnit: "पैक यूनिट", mrpRupees: "MRP (₹)", category: "श्रेणी", subCategory: "उप-श्रेणी", barcode: "बारकोड / EAN", fssaiNumber: "FSSAI नंबर", ingredients: "सामग्री / मुख्य जानकारी", vegMark: "शाकाहारी चिह्न", manufacturer: "निर्माता", expiry: "एक्सपायरी" },
    descEn: "विवरण (अंग्रेज़ी)", descLocal: "विवरण (स्थानीय भाषा)", specsEn: "जानकारी (अंग्रेज़ी), हर लाइन में एक", specsLocal: "जानकारी (स्थानीय भाषा), हर लाइन में एक",
    pending: "जाँच बाकी", inShop: "अब आपकी दुकान में",
  },
  mr: {
    capture: "1. उत्पादनाचे फोटो", sides: { FRONT: "पुढची बाजू", BACK: "मागची बाजू", LABEL: "लेबल", BARCODE: "बारकोड" },
    take: "फोटो काढा / निवडा", remove: "काढा", read: "फोटो वाचा", reading: "फोटो वाचत आहोत…",
    waiting: "तपासायचे बाकी", reviewAll: "तपासा", discard: "रद्द करा", next: "पुढचे उत्पादन (नंतर तपासा)",
    review: "2. माहिती तपासा", low: "कृपया तपासा: AI ला खात्री नव्हती", priceStock: "3. किंमत, साठा आणि युनिट",
    speakBtn: "🎤 किंमत आणि साठा सांगा", listening: "ऐकत आहोत…", typeHint: "किंवा लिहा, उदा. ₹60 प्रति लिटर, 50 बाटल्या",
    understand: "वाचा", price: "विक्री किंमत (₹)", per: "प्रति", stock: "साठा", custom: "तुमचे युनिट (उदा. जुडी)",
    match: "GoKesari कॅटलॉगमध्ये आधीच आहे", useMatch: "हेच उत्पादन वापरा (दुबार नाही)", newProduct: "नवीन उत्पादन म्हणून जोडा",
    newNote: "नवीन उत्पादन लगेच तुमच्या दुकानात दिसेल; इतर दुकानांसाठी आमची टीम तपासेल.",
    mrpWarn: "तुमची किंमत पाकिटावरील MRP पेक्षा जास्त आहे. किंमत कमी करा किंवा MRP दुरुस्त करा.",
    publish: "माझ्या दुकानात प्रसिद्ध करा", publishing: "प्रसिद्ध करत आहोत…", done: "प्रसिद्ध झाले", photosUse: "ग्राहकांना दिसणारे फोटो",
    dupConfirm: "तरीही तयार करा", noVoice: "येथे आवाजाने इनपुट नाही — कृपया लिहा.", retake: "फोटो पुन्हा काढा",
    fields: { brand: "ब्रँड", name: "उत्पादनाचे नाव", variant: "प्रकार / चव", packSize: "पॅक आकार", packUnit: "पॅक युनिट", mrpRupees: "MRP (₹)", category: "वर्ग", subCategory: "उप-वर्ग", barcode: "बारकोड / EAN", fssaiNumber: "FSSAI क्रमांक", ingredients: "घटक / मुख्य माहिती", vegMark: "शाकाहारी खूण", manufacturer: "उत्पादक", expiry: "एक्सपायरी" },
    descEn: "वर्णन (इंग्रजी)", descLocal: "वर्णन (स्थानिक भाषा)", specsEn: "माहिती (इंग्रजी), ओळीत एक", specsLocal: "माहिती (स्थानिक भाषा), ओळीत एक",
    pending: "तपासणी बाकी", inShop: "आता तुमच्या दुकानात",
  },
} as const;

interface Props {
  shopId: string;
  lang: Lang;
  localLang: "hi" | "mr";
  categories: { id: string; name: string }[];
  limits: { maxPhotos: number; maxUploadMb: number; lowConfidenceBelow: number };
}

type FormFields = Record<Exclude<AiFieldKey, "category">, string> & {
  categoryId: string;
  descriptionEn: string;
  descriptionLocal: string;
  specsEn: string;
  specsLocal: string;
};

interface PriceForm {
  text: string;
  price: string;
  priceUnit: SellingUnit;
  stock: string;
  stockUnit: SellingUnit;
  customUnit: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? "Something went wrong.") as Error & { reason?: string; status?: number };
    err.reason = body?.error?.details?.reason;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

function formFrom(d: PhotoListingDraftView): FormFields {
  const s = (k: AiFieldKey) => (d.fields[k].value === null ? "" : String(d.fields[k].value));
  return {
    brand: s("brand"), name: s("name"), variant: s("variant"), packSize: s("packSize"), packUnit: s("packUnit"), mrpRupees: s("mrpRupees"),
    subCategory: s("subCategory"), barcode: s("barcode"), fssaiNumber: s("fssaiNumber"), ingredients: s("ingredients"), vegMark: s("vegMark"),
    manufacturer: s("manufacturer"), expiry: s("expiry"), categoryId: d.categoryId ?? "",
    descriptionEn: d.descriptionEn, descriptionLocal: d.descriptionLocal, specsEn: d.specsEn.join("\n"), specsLocal: d.specsLocal.join("\n"),
  };
}

const EMPTY_PRICE: PriceForm = { text: "", price: "", priceUnit: "piece", stock: "", stockUnit: "piece", customUnit: "" };
const noSubscribe = () => () => undefined;
const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function ShopPhotoListing({ shopId, lang, localLang, categories, limits }: Props) {
  const t = T[lang];
  const base = `/api/shops/${shopId}/photo-listing`;
  const [shots, setShots] = useState<{ file: File; side: Side; url: string }[]>([]);
  const [drafts, setDrafts] = useState<PhotoListingDraftView[]>([]);
  const [current, setCurrent] = useState<PhotoListingDraftView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ name: string; result: PublishResult }[]>([]);

  const loadDrafts = useCallback(async () => {
    setDrafts(await api<PhotoListingDraftView[]>(`${base}/drafts`).catch(() => []));
  }, [base]);
  useEffect(() => {
    let alive = true;
    api<PhotoListingDraftView[]>(`${base}/drafts`)
      .then((d) => {
        if (alive) setDrafts(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [base]);

  function addShot(file: File | undefined, side: Side) {
    if (!file) return;
    if (file.size > limits.maxUploadMb * 1024 * 1024) {
      setError(`${limits.maxUploadMb} MB max.`);
      return;
    }
    setShots((s) => [...s.filter((x) => x.side !== side), { file, side, url: URL.createObjectURL(file) }].slice(0, limits.maxPhotos));
  }

  async function readPhotos() {
    setBusy("read");
    setError(null);
    try {
      const form = new FormData();
      const ordered = SIDES.flatMap((side) => shots.filter((s) => s.side === side));
      for (const s of ordered) {
        form.append("photo", s.file);
        form.append("side", s.side);
      }
      const draft = await api<PhotoListingDraftView>(`${base}/drafts`, { method: "POST", body: form });
      setShots([]);
      setCurrent(draft);
      await loadDrafts();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function discard(id: string) {
    await api(`${base}/drafts/${id}`, { method: "DELETE" }).catch((e: Error) => setError(e.message));
    if (current?.id === id) setCurrent(null);
    await loadDrafts();
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {published.map((p) => (
        <Alert key={p.result.shopProductId} tone="success" title={`${t.done}: ${p.name}`}>
          {p.result.approvalStatus === "PENDING_APPROVAL" ? `${t.inShop} · ${t.pending}` : t.inShop}
          {p.result.notes.map((n) => (
            <span key={n} className="block text-xs">{n}</span>
          ))}
          {p.result.photoErrors.map((n) => (
            <span key={n} className="block text-xs text-amber-800">{n}</span>
          ))}
        </Alert>
      ))}

      {drafts.filter((d) => d.id !== current?.id).length > 0 ? (
        <Card>
          <h2 className="mb-2 font-semibold">{t.waiting} ({drafts.filter((d) => d.id !== current?.id).length})</h2>
          <ul className="divide-y divide-cream-200">
            {drafts
              .filter((d) => d.id !== current?.id)
              .map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2">
                  {d.photos[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- private draft photo, not optimisable
                    <img src={d.photos[0].url} alt="" className="h-12 w-12 rounded object-cover" />
                  ) : null}
                  <span className="flex-1 text-sm">
                    {[d.fields.brand.value, d.fields.name.value].filter(Boolean).join(" ") || (d.status === "UNREADABLE" ? d.retakeMessage : "—")}
                  </span>
                  {d.status === "DRAFT" ? (
                    <Button size="sm" onClick={() => setCurrent(d)}>{t.reviewAll}</Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void discard(d.id)}>{t.discard}</Button>
                </li>
              ))}
          </ul>
        </Card>
      ) : null}

      {current ? (
        <DraftReview
          key={current.id}
          draft={current}
          shopId={shopId}
          lang={lang}
          localLang={localLang}
          categories={categories}
          onClose={() => setCurrent(null)}
          onDiscard={() => void discard(current.id)}
          onPublished={(name, result) => {
            setPublished((p) => [{ name, result }, ...p].slice(0, 5));
            setCurrent(null);
            void loadDrafts();
          }}
        />
      ) : (
        <Card>
          <h2 className="mb-1 font-semibold">{t.capture}</h2>
          <p className="mb-3 text-xs text-ink-500">1–{limits.maxPhotos} · JPG/PNG/WebP · ≤ {limits.maxUploadMb} MB</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SIDES.slice(0, limits.maxPhotos).map((side) => {
              const shot = shots.find((s) => s.side === side);
              return (
                <div key={side} className="rounded-lg border border-dashed border-cream-200 p-2 text-center">
                  <p className="mb-1 text-xs font-medium">{t.sides[side]}</p>
                  {shot ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- private draft photos and local previews, not optimisable */}
                      <img src={shot.url} alt={t.sides[side]} className="mx-auto h-24 w-full rounded object-cover" />
                      <Button size="sm" variant="ghost" onClick={() => setShots((s) => s.filter((x) => x.side !== side))}>{t.remove}</Button>
                    </>
                  ) : (
                    <label className="flex h-24 cursor-pointer items-center justify-center rounded bg-cream-100 text-xs text-ink-600">
                      📷 {t.take}
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(e) => addShot(e.target.files?.[0], side)} />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <Button disabled={shots.length === 0 || busy !== null} onClick={() => void readPhotos()}>
              {busy === "read" ? t.reading : t.read}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function DraftReview({
  draft,
  shopId,
  lang,
  localLang,
  categories,
  onClose,
  onDiscard,
  onPublished,
}: {
  draft: PhotoListingDraftView;
  shopId: string;
  lang: Lang;
  localLang: "hi" | "mr";
  categories: { id: string; name: string }[];
  onClose: () => void;
  onDiscard: () => void;
  onPublished: (name: string, result: PublishResult) => void;
}) {
  const t = T[lang];
  const base = `/api/shops/${shopId}/photo-listing`;
  const [form, setForm] = useState<FormFields>(() => formFrom(draft));
  const [price, setPrice] = useState<PriceForm>(EMPTY_PRICE);
  const [useMatch, setUseMatch] = useState(Boolean(draft.match));
  const [photoIds, setPhotoIds] = useState<string[]>(draft.photos.filter((p) => p.side !== "BARCODE").map((p) => p.id));
  const [heard, setHeard] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  // Known only in the browser (the app's recogniser or the Web Speech API); false while rendering on the server.
  const canSpeak = useSyncExternalStore(noSubscribe, voiceInputAvailable, () => false);

  const low = new Set(draft.lowConfidence);
  const set = (k: keyof FormFields, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const said = useMemo(
    () => ({
      pricePaise: num(price.price) === null ? null : Math.round(num(price.price)! * 100),
      priceUnit: price.priceUnit,
      stock: num(price.stock),
      stockUnit: price.stockUnit,
      customUnit: price.customUnit || null,
      stockWord: null,
    }),
    [price],
  );
  const quantities = useMemo(() => {
    const existing = useMatch && draft.match ? packInBase(draft.match.unit, draft.match.unitSizeMilli) : null;
    return toListingQuantities(said, { size: num(form.packSize), unit: packUnitFromLabel(form.packUnit) }, existing);
  }, [said, form.packSize, form.packUnit, useMatch, draft.match]);
  const mrpPaise = num(form.mrpRupees) !== null ? Math.round(num(form.mrpRupees)! * 100) : useMatch ? (draft.match?.mrpPaise ?? null) : null;
  const aboveMrp = priceAboveMrp(quantities.pricePaise, mrpPaise);

  function applyParse(p: SpokenPriceStock["parse"]) {
    setPrice((cur) => ({
      ...cur,
      price: p.pricePaise !== null ? String(p.pricePaise / 100) : cur.price,
      priceUnit: p.priceUnit ?? cur.priceUnit,
      stock: p.stock !== null ? String(p.stock) : cur.stock,
      stockUnit: p.stockUnit ?? p.priceUnit ?? cur.stockUnit,
      customUnit: p.customUnit ?? cur.customUnit,
    }));
  }

  async function understand(text: string) {
    if (!text.trim()) return;
    // The deterministic reader answers at once; the server is asked only when something is missing.
    const local = parsePriceStock(text);
    let parse = local;
    let back = readBack(local, lang);
    if (!local.complete) {
      setBusy("voice");
      try {
        const r = await api<SpokenPriceStock>(`${base}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        parse = r.parse;
        back = r.readBack[lang];
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    }
    applyParse(parse);
    setHeard(back);
    speak(back, VOICE_LANG[lang]);
  }

  async function listen() {
    setError(null);
    setBusy("listen");
    try {
      const text = await listenOnce(VOICE_LANG[lang]);
      setPrice((p) => ({ ...p, text }));
      setBusy(null);
      await understand(text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function publish(confirmDuplicate = false) {
    setBusy("publish");
    setError(null);
    try {
      const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
      const body = {
        fields: {
          brand: form.brand, name: form.name, variant: form.variant, packSize: num(form.packSize), packUnit: form.packUnit,
          mrpRupees: num(form.mrpRupees), categoryId: form.categoryId || null, subCategory: form.subCategory, barcode: form.barcode,
          fssaiNumber: form.fssaiNumber, ingredients: form.ingredients, vegMark: form.vegMark || null, manufacturer: form.manufacturer,
          expiry: form.expiry, descriptionEn: form.descriptionEn, descriptionLocal: form.descriptionLocal,
          specsEn: lines(form.specsEn), specsLocal: lines(form.specsLocal),
        },
        price: {
          pricePaise: said.pricePaise, priceUnit: price.priceUnit, stock: said.stock, stockUnit: price.stockUnit,
          customUnit: price.customUnit || null, voiceText: price.text || null,
        },
        matchProductId: useMatch && draft.match ? draft.match.productId : null,
        photoIds,
        confirmDuplicate,
      };
      const result = await api<PublishResult>(`${base}/drafts/${draft.id}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onPublished([form.brand, form.name].filter(Boolean).join(" "), result);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409 && /similar/i.test(err.message)) setDupWarning(err.message);
      else setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const text = (k: Exclude<AiFieldKey, "category" | "vegMark">, wide = false) => (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <Field label={<>{t.fields[k]} {low.has(k) ? <Badge tone="warning">{draft.fields[k].confidence}%</Badge> : null}</>}>
        <input
          className={`${inputClass} ${low.has(k) ? "border-amber-400 bg-amber-50" : ""}`}
          value={form[k]}
          inputMode={k === "packSize" || k === "mrpRupees" ? "decimal" : undefined}
          onChange={(e) => set(k, e.target.value)}
        />
      </Field>
    </div>
  );

  if (draft.status === "UNREADABLE") {
    return (
      <Card>
        <Alert tone="warning" title={t.retake}>{draft.retakeMessage}</Alert>
        <div className="mt-3 flex gap-2">
          <Button onClick={onDiscard}>{t.retake}</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-2">
        {draft.photos.map((p) => (
          <label key={p.id} className="text-center text-xs">
            {/* eslint-disable-next-line @next/next/no-img-element -- private draft photos and local previews, not optimisable */}
            <img src={p.url} alt={t.sides[p.side as Side] ?? p.side} className="h-20 w-20 rounded object-cover" />
            <input
              type="checkbox"
              checked={photoIds.includes(p.id)}
              onChange={(e) => setPhotoIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((i) => i !== p.id)))}
            />{" "}
            {t.sides[p.side as Side] ?? p.side}
          </label>
        ))}
        <span className="self-center text-xs text-ink-500">{t.photosUse}</span>
      </div>

      {draft.match ? (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
          <p className="font-semibold">{t.match}: {draft.match.name}</p>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={useMatch} onChange={() => setUseMatch(true)} /> {t.useMatch}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!useMatch} onChange={() => setUseMatch(false)} /> {t.newProduct}
          </label>
        </div>
      ) : null}
      {!useMatch ? <p className="mb-3 text-xs text-ink-500">{t.newNote}</p> : null}

      <h2 className="mb-2 font-semibold">{t.review}</h2>
      {draft.lowConfidence.length ? <p className="mb-2 text-xs text-amber-800">{t.low}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("brand")}
        {text("name")}
        {text("variant")}
        {text("packSize")}
        {text("packUnit")}
        {text("mrpRupees")}
        <Field label={t.fields.category}>
          <select className={inputClass} value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            <option value="">General</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        {text("subCategory")}
        {text("barcode")}
        {text("fssaiNumber")}
        <Field label={<>{t.fields.vegMark} {low.has("vegMark") ? <Badge tone="warning">{draft.fields.vegMark.confidence}%</Badge> : null}</>}>
          <select className={inputClass} value={form.vegMark} onChange={(e) => set("vegMark", e.target.value)}>
            <option value="">—</option>
            <option value="VEG">VEG 🟢</option>
            <option value="NON_VEG">NON-VEG 🔺</option>
            <option value="NONE">NONE</option>
          </select>
        </Field>
        {text("manufacturer")}
        {text("expiry")}
        {text("ingredients", true)}
        <div className="sm:col-span-2">
          <Field label={t.descEn}>
            <textarea className={inputClass} rows={2} value={form.descriptionEn} onChange={(e) => set("descriptionEn", e.target.value)} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={`${t.descLocal} (${localLang === "mr" ? "मराठी" : "हिन्दी"})`}>
            <textarea className={inputClass} rows={2} value={form.descriptionLocal} onChange={(e) => set("descriptionLocal", e.target.value)} lang={localLang} />
          </Field>
        </div>
        <Field label={t.specsEn}>
          <textarea className={inputClass} rows={4} value={form.specsEn} onChange={(e) => set("specsEn", e.target.value)} />
        </Field>
        <Field label={t.specsLocal}>
          <textarea className={inputClass} rows={4} value={form.specsLocal} onChange={(e) => set("specsLocal", e.target.value)} lang={localLang} />
        </Field>
      </div>

      <h2 className="mb-2 mt-5 font-semibold">{t.priceStock}</h2>
      <div className="flex flex-wrap items-end gap-2">
        {canSpeak ? (
          <Button variant="secondary" disabled={busy !== null} onClick={() => void listen()}>
            {busy === "listen" ? t.listening : t.speakBtn}
          </Button>
        ) : (
          <p className="w-full text-xs text-ink-500">{t.noVoice}</p>
        )}
        <input
          className={`${inputClass} min-w-0 flex-1`}
          placeholder={t.typeHint}
          value={price.text}
          onChange={(e) => setPrice((p) => ({ ...p, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void understand(price.text);
          }}
        />
        <Button variant="secondary" disabled={busy !== null || !price.text.trim()} onClick={() => void understand(price.text)}>{t.understand}</Button>
      </div>
      {heard ? (
        <p className="mt-2 rounded bg-cream-100 p-2 text-sm" aria-live="polite">
          🔊 {heard}
        </p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label={t.price}>
          <input className={inputClass} inputMode="decimal" value={price.price} onChange={(e) => setPrice((p) => ({ ...p, price: e.target.value }))} />
        </Field>
        <Field label={t.per}>
          <select className={inputClass} value={price.priceUnit} onChange={(e) => setPrice((p) => ({ ...p, priceUnit: e.target.value as SellingUnit }))}>
            {SELLING_UNITS.map((u) => (
              <option key={u} value={u}>{unitLabel(u, lang, u === "custom" ? price.customUnit || null : null)}</option>
            ))}
          </select>
        </Field>
        <Field label={t.stock}>
          <input className={inputClass} inputMode="decimal" value={price.stock} onChange={(e) => setPrice((p) => ({ ...p, stock: e.target.value }))} />
        </Field>
        <Field label={"\u00a0"}>
          <select className={inputClass} value={price.stockUnit} onChange={(e) => setPrice((p) => ({ ...p, stockUnit: e.target.value as SellingUnit }))}>
            {SELLING_UNITS.map((u) => (
              <option key={u} value={u}>{unitLabel(u, lang, u === "custom" ? price.customUnit || null : null)}</option>
            ))}
          </select>
        </Field>
        {price.priceUnit === "custom" || price.stockUnit === "custom" ? (
          <Field label={t.custom}>
            <input className={inputClass} value={price.customUnit} onChange={(e) => setPrice((p) => ({ ...p, customUnit: e.target.value }))} />
          </Field>
        ) : null}
      </div>
      {quantities.notes.map((n) => (
        <p key={n} className="mt-1 text-xs text-ink-500">{n}</p>
      ))}
      {aboveMrp ? (
        <div className="mt-3">
          <Alert tone="warning">{t.mrpWarn}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {dupWarning ? (
        <div className="mt-3">
          <Alert tone="warning">
            {dupWarning}{" "}
            <Button size="sm" variant="secondary" onClick={() => void publish(true)}>{t.dupConfirm}</Button>
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="lg" disabled={busy !== null || form.name.trim().length < 2 || aboveMrp} onClick={() => void publish()}>
          {busy === "publish" ? t.publishing : t.publish}
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={onClose}>{t.next}</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={onDiscard}>{t.discard}</Button>
      </div>
    </Card>
  );
}
