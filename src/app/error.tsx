"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";

import { Icon } from "@/components/board/icons";
import { LANG_COOKIE, LANG_TAG, parseLang, tr, UI } from "@/lib/board/i18n";

const noSubscription = () => () => {};

/**
 * Error state for every page: what happened in plain words, that nothing was
 * lost, and two ways forward — try again, or back to the home board.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const lang = useSyncExternalStore(
    noSubscription,
    () => parseLang(document.cookie.split("; ").find((c) => c.startsWith(`${LANG_COOKIE}=`))?.split("=")[1]),
    () => parseLang(undefined),
  );
  return (
    <div lang={LANG_TAG[lang]} role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 py-10 text-center" data-testid="error-state">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-red-50 text-red-700">
        <Icon name="circle-alert" size={30} />
      </span>
      <h1 className="text-xl font-bold text-ink-900">{tr(UI.errorTitle, lang)}</h1>
      <p className="text-base text-ink-700">{tr(UI.errorText, lang)}</p>
      {error.digest ? <p className="text-sm text-ink-600">Ref: {error.digest}</p> : null}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => retry()} className="flex h-12 items-center gap-2 rounded-xl bg-kesari-700 px-5 text-base font-bold text-white hover:bg-kesari-800">
          <Icon name="refresh-cw" size={18} />
          {tr(UI.tryAgain, lang)}
        </button>
        <Link href="/" className="flex h-12 items-center gap-2 rounded-xl border-2 border-kesari-600 px-5 text-base font-bold text-kesari-800 hover:bg-kesari-50">
          <Icon name="layout-grid" size={18} />
          {tr(UI.home, lang)}
        </Link>
      </div>
    </div>
  );
}
