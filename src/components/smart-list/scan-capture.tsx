"use client";

/**
 * "Scan my list" capture (docs/smart-shopping-2026-11, Feature 1 §1–2): camera or gallery, several pages,
 * rotate / retake / remove per page; each photo is oriented, auto-cropped and compressed in the browser
 * before upload. The read lines open in the wishlist editor. An unreadable photo is explained and the
 * customer is asked to retake it — never an empty wishlist.
 */
import { useState } from "react";

import { tr, type Lang } from "@/lib/board/i18n";
import { prepareListPhoto } from "@/lib/smart-list-image";
import { LANGUAGE_NAMES, type ScannedLine, UNREADABLE_MESSAGES } from "@/lib/smart-list";

import { type EditorItem, WishlistEditor } from "./wishlist-editor";

type Page = { id: string; file: File; url: string; rotation: 0 | 90 | 180 | 270 };

const T = {
  camera: { en: "📷 Take photo", hi: "📷 फोटो लें", mr: "📷 फोटो काढा" },
  gallery: { en: "🖼️ From gallery", hi: "🖼️ गैलरी से", mr: "🖼️ गॅलरीमधून" },
  pages: { en: "Pages", hi: "पेज", mr: "पाने" },
  rotate: { en: "Rotate", hi: "घुमाएँ", mr: "फिरवा" },
  remove: { en: "Remove", hi: "हटाएँ", mr: "काढा" },
  read: { en: "Read my list", hi: "मेरी सूची पढ़ें", mr: "माझी यादी वाचा" },
  reading: { en: "Reading your list…", hi: "आपकी सूची पढ़ी जा रही है…", mr: "तुमची यादी वाचत आहोत…" },
  hint: {
    en: "Lay the list flat in good light and fill the frame. Add another page for a long list.",
    hi: "सूची को अच्छी रोशनी में सीधा रखें और पूरा फ्रेम भरें। लंबी सूची के लिए दूसरा पेज जोड़ें।",
    mr: "यादी चांगल्या प्रकाशात सपाट ठेवा आणि पूर्ण फ्रेम भरा. मोठ्या यादीसाठी दुसरे पान जोडा.",
  },
  retake: { en: "Retake photo", hi: "फिर से फोटो लें", mr: "पुन्हा फोटो काढा" },
  found: { en: "items found", hi: "आइटम मिले", mr: "वस्तू सापडल्या" },
  lang: { en: "Language", hi: "भाषा", mr: "भाषा" },
  bill: {
    en: "This looks like a shop bill: only product names were taken, not the bill amounts. Check the quantities.",
    hi: "यह दुकान का बिल लगता है: केवल उत्पादों के नाम लिए गए, बिल की रकम नहीं। मात्रा जाँचें।",
    mr: "हे दुकानाचे बिल दिसते: फक्त उत्पादनांची नावे घेतली, बिलाची रक्कम नाही. प्रमाण तपासा.",
  },
};

export function ScanCapture({ lang, maxPages, lowConfidenceBelow }: { lang: Lang; maxPages: number; lowConfidenceBelow: number }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ scanId: string; lines: ScannedLine[]; languages: string[]; isBill: boolean } | null>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...pages];
    for (const file of Array.from(list)) {
      if (next.length >= maxPages) break;
      next.push({ id: `${Date.now()}-${next.length}`, file, url: URL.createObjectURL(file), rotation: 0 });
    }
    setPages(next);
    setError(null);
  }

  async function read() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const p of pages) form.append("page", await prepareListPhoto(p.file, p.rotation), "page.jpg");
      form.append("lang", lang);
      const res = await fetch("/api/smart-list/scans", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not read the photo. Try again.");
        return;
      }
      if (body.status !== "READ") {
        setError(UNREADABLE_MESSAGES[body.unreadableReason] ?? UNREADABLE_MESSAGES.EMPTY);
        return;
      }
      setResult({ scanId: body.scanId, lines: body.lines, languages: body.languages, isBill: body.isBill });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const items: EditorItem[] = result.lines.map((l, i) => {
      const best = l.candidates.find((c) => c.productId === l.productId) ?? null;
      return {
        key: `l${i}`,
        originalText: l.raw,
        originalLang: l.language,
        nameEn: l.nameEn,
        nameLocal: l.nameLocal,
        productId: l.productId,
        productName: best?.name ?? null,
        aiProductId: l.productId,
        matchConfidence: l.productId ? l.matchConfidence : null,
        candidates: l.candidates,
        quantityAmount: l.quantityAmount,
        quantityUnit: l.quantityUnit,
        userEdited: false,
      };
    });
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-3">
          {pages.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.id} src={p.url} alt="" className="h-24 w-20 rounded-lg object-cover" style={{ transform: `rotate(${p.rotation}deg)` }} />
          ))}
          <div className="text-sm">
            <strong>
              {result.lines.length} {tr(T.found, lang)}
            </strong>
            <div>
              {tr(T.lang, lang)}: {result.languages.map((l) => LANGUAGE_NAMES[l] ?? l).join(" + ") || "—"}
            </div>
          </div>
        </div>
        {result.isBill ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{tr(T.bill, lang)}</p> : null}
        <WishlistEditor lang={lang} initial={items} lowConfidenceBelow={lowConfidenceBelow} scanId={result.scanId} />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="scan-capture">
      <p className="text-sm text-ink-700">{tr(T.hint, lang)}</p>
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex h-12 cursor-pointer items-center rounded-xl bg-kesari-600 px-5 font-bold text-white">
          {tr(T.camera, lang)}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => addFiles(e.target.files)} data-testid="scan-camera" />
        </label>
        <label className="inline-flex h-12 cursor-pointer items-center rounded-xl border-2 border-kesari-600 px-5 font-bold text-kesari-800">
          {tr(T.gallery, lang)}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="sr-only" onChange={(e) => addFiles(e.target.files)} data-testid="scan-gallery" />
        </label>
      </div>
      {pages.length > 0 ? (
        <>
          <h2 className="font-bold">
            {tr(T.pages, lang)} ({pages.length}/{maxPages})
          </h2>
          <ul className="flex flex-wrap gap-3">
            {pages.map((p, i) => (
              <li key={p.id} className="w-36 rounded-xl border bg-white p-2 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={`Page ${i + 1}`} className="mx-auto h-36 w-full object-contain" style={{ transform: `rotate(${p.rotation}deg)` }} />
                <div className="mt-1 flex justify-between gap-1">
                  <button
                    type="button"
                    className="min-h-10 flex-1 rounded-lg border text-xs font-semibold"
                    onClick={() => setPages((all) => all.map((x) => (x.id === p.id ? { ...x, rotation: (((x.rotation + 90) % 360) as Page["rotation"]) } : x)))}
                  >
                    ↻ {tr(T.rotate, lang)}
                  </button>
                  <button type="button" className="min-h-10 flex-1 rounded-lg border text-xs font-semibold text-red-700" onClick={() => setPages((all) => all.filter((x) => x.id !== p.id))}>
                    {tr(T.remove, lang)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void read()} className="h-12 rounded-xl bg-ink-900 px-6 font-bold text-white disabled:opacity-60" data-testid="scan-read">
            {busy ? tr(T.reading, lang) : tr(T.read, lang)}
          </button>
        </>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900" data-testid="scan-error">
          {error}
          <div className="mt-2">
            <button type="button" onClick={() => setPages([])} className="h-10 rounded-lg border border-red-400 px-3 font-semibold">
              {tr(T.retake, lang)}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
