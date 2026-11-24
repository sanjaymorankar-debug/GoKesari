"use client";

/**
 * Scan a barcode from the customer search box (docs/search-brand-barcode-favourites-2026-11; shown only
 * while the flag brand_barcode_favourites_enabled is on). Opens a sheet with the shared camera scanner
 * (which also takes a typed number), asks GET /api/products/barcode and lists what it found — each one
 * linking to its product page, where every shop's price is. An invalid number is reported as such.
 */
import Link from "next/link";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";

import { BarcodeScanner } from "@/components/barcode-scanner";
import { Icon } from "@/components/board/icons";
import { SafeImage } from "@/components/safe-image";
import { Button, Money } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { BBF } from "@/lib/brand-barcode-favourites-i18n";
import { validateRetailBarcode } from "@/lib/retail-barcode";

interface Match {
  productId: string;
  name: string;
  brandName: string | null;
  brandSlug: string | null;
  imageUrl: string | null;
  packSize: string;
  mrpPaise: number | null;
  href: string;
  shopCount: number;
  nearby: { shopCount: number; lowestPricePaise: number | null; buyable: boolean } | null;
}

type State =
  | { step: "scan" }
  | { step: "loading"; code: string }
  | { step: "error"; code: string; message: string }
  | { step: "done"; code: string; matches: Match[] };

export function BarcodeSearchButton({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={tr(BBF.scanBarcode, lang)}
        title={tr(BBF.scanBarcode, lang)}
        data-testid="barcode-search"
        onClick={() => setOpen(true)}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-kesari-700 hover:bg-kesari-50"
      >
        <Icon name="scan-barcode" size={20} />
      </button>
      {/* In a portal: the button sits inside the search form, and the scanner has a form of its own. React
          still bubbles events through the portal, so the scanner's submit is stopped before the search form. */}
      {open
        ? createPortal(
            <div onSubmit={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <BarcodeSearchSheet lang={lang} onClose={() => setOpen(false)} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function BarcodeSearchSheet({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const [state, setState] = useState<State>({ step: "scan" });

  const lookUp = useCallback(async (raw: string) => {
    const valid = validateRetailBarcode(raw);
    if (!valid.ok) {
      setState({ step: "error", code: raw, message: valid.message });
      return;
    }
    setState({ step: "loading", code: valid.code });
    try {
      const res = await fetch(`/api/products/barcode?code=${encodeURIComponent(valid.code)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setState({ step: "error", code: valid.code, message: data?.error?.message ?? tr(BBF.lookupFailed, lang) });
        return;
      }
      setState({ step: "done", code: valid.code, matches: (data?.matches ?? []) as Match[] });
    } catch {
      setState({ step: "error", code: valid.code, message: tr(BBF.lookupFailed, lang) });
    }
  }, [lang]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="barcode-search-title">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl" data-testid="barcode-search-sheet">
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 id="barcode-search-title" className="text-base font-bold text-ink-900">
            {tr(BBF.scanTitle, lang)}
          </h2>
          <button type="button" aria-label={tr(BBF.close, lang)} onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg text-ink-600 hover:bg-cream-100">
            <Icon name="x" size={18} />
          </button>
        </div>

        {state.step === "scan" ? (
          <>
            <p className="mb-2 text-sm text-ink-600">{tr(BBF.scanHelp, lang)}</p>
            <BarcodeScanner onCode={lookUp} onClose={onClose} />
          </>
        ) : null}

        {state.step === "loading" ? (
          <p role="status" className="py-6 text-center text-sm text-ink-700">
            {tr(BBF.looking, lang)} <span className="tabular-nums">{state.code}</span>
          </p>
        ) : null}

        {state.step === "error" ? (
          <div className="space-y-3">
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800" data-testid="barcode-search-error">
              {state.message}
            </p>
            <Button type="button" variant="secondary" onClick={() => setState({ step: "scan" })}>
              {tr(BBF.scanAgain, lang)}
            </Button>
          </div>
        ) : null}

        {state.step === "done" ? (
          <div className="space-y-3" data-testid="barcode-search-results">
            <p className="text-xs text-ink-500 tabular-nums">{state.code}</p>
            {state.matches.length === 0 ? <p className="text-sm text-ink-700">{tr(BBF.noMatch, lang)}</p> : null}
            {state.matches.length > 1 ? <p className="text-sm font-semibold text-ink-800">{tr(BBF.severalMatches, lang)}</p> : null}
            <ul className="divide-y divide-cream-200">
              {state.matches.map((m) => (
                <li key={m.productId} className="flex gap-3 py-3" data-testid="barcode-match">
                  <SafeImage src={m.imageUrl} size="thumb" alt={m.name} className="h-14 w-14 shrink-0 rounded-lg bg-cream-100 object-cover" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-semibold text-ink-900">{m.name}</p>
                    <p className="text-xs text-ink-600">
                      {[m.brandName, m.packSize].filter(Boolean).join(" · ")}
                      {m.mrpPaise != null ? (
                        <>
                          {" · "}
                          {tr(BBF.mrp, lang)} <Money paise={m.mrpPaise} />
                        </>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-700">
                      {m.nearby
                        ? m.nearby.shopCount > 0
                          ? (
                            <>
                              {m.nearby.shopCount} {tr(BBF.shopsNearYou, lang)}
                              {m.nearby.lowestPricePaise != null ? (
                                <>
                                  {" · "}
                                  {tr(BBF.from, lang)} <Money paise={m.nearby.lowestPricePaise} />
                                </>
                              ) : null}
                            </>
                          )
                          : tr(BBF.notNearYou, lang)
                        : m.shopCount === 0
                          ? tr(BBF.notSold, lang)
                          : null}
                    </p>
                    {m.shopCount > 0 ? (
                      <Link href={m.href} onClick={onClose} className="mt-1 inline-flex min-h-9 items-center text-sm font-bold text-kesari-700 hover:underline">
                        {tr(BBF.viewProduct, lang)}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <Button type="button" variant="secondary" onClick={() => setState({ step: "scan" })}>
              {tr(BBF.scanAgain, lang)}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
