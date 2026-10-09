"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { LANG_COOKIE, LANG_COOKIE_MAX_AGE_SECONDS, LANG_NAME, LANG_SHORT, LANGS, type Lang } from "@/lib/tile-board/i18n";

/**
 * EN | हिं | मरा — the three-way language switch in the board's header.
 *
 * The choice is kept in a cookie and the page is re-rendered on the server in
 * that language, so nothing flashes in the wrong language on the next visit.
 */
export function LanguageSwitch({ lang, label }: { lang: Lang; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Lang) {
    if (next === lang) return;
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=${LANG_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label={label}
      data-testid="language-switch"
      className={`flex shrink-0 items-stretch overflow-hidden rounded-full border border-kesari-300 bg-white text-[12px] font-semibold ${pending ? "opacity-70" : ""}`}
    >
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          title={LANG_NAME[code]}
          aria-label={LANG_NAME[code]}
          aria-pressed={code === lang}
          onClick={() => choose(code)}
          className={`min-w-[30px] px-2 py-1.5 leading-none transition-colors ${
            code === lang ? "bg-kesari-600 text-white" : "text-ink-600 hover:bg-kesari-50"
          }`}
        >
          {LANG_SHORT[code]}
        </button>
      ))}
    </div>
  );
}
