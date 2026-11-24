"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { LANG_TAG, tr, type Lang } from "@/lib/board/i18n";
import {
  POLICY_DOC_LABEL,
  RECONSENT_UI,
  reconsentExemptPath,
  summaryIn,
  type PolicyDocSlug,
  type PolicySummaryText,
} from "@/lib/policy-reconsent";
import { signOutAction } from "@/server/sign-out-action";

import { Icon } from "./board/icons";

export interface GatePolicy {
  doc: PolicyDocSlug;
  version: string;
  summary: PolicySummaryText;
}

/**
 * docs/policy-reconsent-2026-11: the page a signed-in user sees when a policy
 * they accepted has a new version that needs acceptance. It covers every page
 * (customer site, shop, rider and dealer portals, the app's WebView) except the
 * policies themselves, which stay readable in a new tab. Polite: what changed,
 * a link to the full text, one checkbox, and "sign out" as the way to decline.
 * Rendered by the root layout only while the flag is on and something is pending.
 */
export function PolicyReconsentGate({ lang, pending }: { lang: Lang; pending: GatePolicy[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const show = !done && pending.length > 0 && !reconsentExemptPath(pathname);

  // Keep the page behind still: no scrolling it while the dialog is up.
  useEffect(() => {
    if (!show) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [show]);

  if (!show) return null;

  async function accept() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/me/policy-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept: pending.map((p) => ({ doc: p.doc, version: p.version })), path: pathname }),
      });
      if (response.status === 409) {
        // A newer version was published while this was open: show it.
        router.refresh();
        setAgreed(false);
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      setDone(true);
      router.refresh();
    } catch {
      setError(tr(RECONSENT_UI.failed, lang));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      lang={LANG_TAG[lang]}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-4"
      data-testid="policy-reconsent"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-reconsent-title"
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kesari-100 text-kesari-700">
            <Icon name="file-check" size={20} />
          </span>
          <div className="min-w-0">
            <h2 id="policy-reconsent-title" className="text-lg font-semibold text-ink-900">
              {tr(RECONSENT_UI.title, lang)}
            </h2>
            <p className="mt-1 text-sm text-ink-600">{tr(RECONSENT_UI.intro, lang)}</p>
          </div>
        </div>

        <ul className="mt-4 space-y-3">
          {pending.map((p) => {
            const summary = summaryIn(p.summary, lang);
            return (
              <li key={p.doc} className="rounded-xl border border-cream-200 p-3" data-testid={`policy-reconsent-${p.doc}`}>
                <p className="font-semibold text-ink-900">
                  {tr(POLICY_DOC_LABEL[p.doc], lang)}{" "}
                  <span className="text-xs font-normal text-ink-500">
                    {tr(RECONSENT_UI.version, lang)} {p.version}
                  </span>
                </p>
                {summary ? (
                  <>
                    <p className="mt-2 text-xs font-medium uppercase tracking-wide text-ink-500">{tr(RECONSENT_UI.whatChanged, lang)}</p>
                    <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{summary}</p>
                  </>
                ) : null}
                <a
                  href={`/legal/${p.doc}`}
                  target="_blank"
                  rel="noopener"
                  className="mt-2 inline-block text-sm font-medium text-kesari-700 underline"
                >
                  {tr(RECONSENT_UI.readFull, lang)}
                </a>
              </li>
            );
          })}
        </ul>

        <label className="mt-4 flex items-start gap-2 text-sm text-ink-800">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-testid="policy-reconsent-agree"
          />
          <span>{tr(RECONSENT_UI.agree, lang)}</span>
        </label>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <form action={signOutAction}>
            <button type="submit" className="text-sm text-ink-600 underline">
              {tr(RECONSENT_UI.signOut, lang)}
            </button>
          </form>
          <button
            type="button"
            disabled={!agreed || saving}
            onClick={accept}
            data-testid="policy-reconsent-accept"
            className="rounded-xl bg-kesari-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? tr(RECONSENT_UI.saving, lang) : tr(RECONSENT_UI.accept, lang)}
          </button>
        </div>
        <p className="mt-4 text-xs text-ink-500">
          {tr(RECONSENT_UI.questions, lang)}{" "}
          <a href="/legal/grievance-redressal" target="_blank" rel="noopener" className="underline">
            /legal/grievance-redressal
          </a>
        </p>
      </div>
    </div>
  );
}
