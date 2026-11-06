import Link from "next/link";

import { tr, UI, type Lang } from "@/lib/board/i18n";
import type { SetupItemKey, ShopSetupChecklist } from "@/server/services/shop-setup-checklist";

const LABEL: Record<SetupItemKey, keyof typeof UI> = {
  pin: "setupPin",
  categories: "setupCategories",
  products: "setupProducts",
  bank: "setupBank",
  delivery: "setupDelivery",
  documents: "setupDocuments",
};

/**
 * "Finish set-up" (onboarding Phase B, G20): the new shop's remaining set-up as tiles with their
 * live status, at the top of Seller Central on every screen size, until everything is done.
 */
export function SetupChecklist({ lang, checklist, shareHref }: { lang: Lang; checklist: ShopSetupChecklist; shareHref: string | null }) {
  if (checklist.complete) return null;
  return (
    <section className="mb-4 rounded-2xl border border-kesari-100 bg-kesari-50 p-3 sm:p-4" aria-labelledby="setup-title" data-testid="setup-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="setup-title" className="text-base font-semibold text-ink-900">
          {tr(UI.setupTitle, lang)}
        </h2>
        <p className="text-sm text-ink-600">
          {checklist.done} / {checklist.total} {tr(UI.setupDone, lang)}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white" aria-hidden>
        <div className="h-full rounded-full bg-leaf-500" style={{ width: `${Math.round((checklist.done / checklist.total) * 100)}%` }} />
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {checklist.items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className={`flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                item.done ? "border-leaf-300 bg-leaf-50 text-leaf-700" : "border-[var(--gk-line)] bg-white font-medium text-ink-900"
              }`}
              data-testid={`setup-${item.key}`}
            >
              <span aria-hidden>{item.done ? "✓" : "○"}</span>
              <span className="min-w-0 flex-1">
                {tr(UI[LABEL[item.key]], lang)}
                {item.progress && !item.done ? ` (${item.progress.have}/${item.progress.target})` : null}
              </span>
              <span className="sr-only">{item.done ? tr(UI.setupDone, lang) : ""}</span>
            </Link>
          </li>
        ))}
        {shareHref ? (
          <li>
            <Link href={shareHref} className="flex min-h-12 items-center gap-2 rounded-xl border border-[var(--gk-line)] bg-white px-3 py-2 text-sm font-medium text-ink-900">
              <span aria-hidden>↗</span>
              <span>{tr(UI.setupShare, lang)}</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
