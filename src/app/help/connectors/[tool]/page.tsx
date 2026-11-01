import Link from "next/link";
import { notFound } from "next/navigation";

import { parseLang, tr, type Lang } from "@/lib/board/i18n";
import { CONNECTOR_GUIDES } from "@/lib/billing/connector-help";
import { getBoardLang } from "@/server/board-lang";

export const dynamic = "force-dynamic";

const HEAD: Record<Lang, { to: string; from: string; sends: string; back: string }> = {
  en: { to: "From GoKesari to the software", from: "From the software to GoKesari", sends: "What GoKesari sends", back: "Back to sync" },
  hi: { to: "GoKesari से सॉफ़्टवेयर में", from: "सॉफ़्टवेयर से GoKesari में", sends: "GoKesari क्या भेजता है", back: "सिंक पर वापस" },
  mr: { to: "GoKesari मधून सॉफ्टवेअरमध्ये", from: "सॉफ्टवेअरमधून GoKesari मध्ये", sends: "GoKesari काय पाठवते", back: "सिंककडे परत" },
};

export async function generateMetadata({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  return { title: `${CONNECTOR_GUIDES[tool]?.name ?? "Connector"} — help` };
}

/** Billing v2 (docs/billing §8): one software's step-by-step guide, in English, Hindi or Marathi (?lang=). */
export default async function ConnectorHelpPage({ params, searchParams }: { params: Promise<{ tool: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { tool } = await params;
  const guide = CONNECTOR_GUIDES[tool];
  if (!guide) notFound();
  const sp = await searchParams;
  const lang: Lang = sp.lang ? parseLang(sp.lang) : await getBoardLang();
  const h = HEAD[lang];
  return (
    <article className="mx-auto max-w-3xl p-4" lang={lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN"}>
      <nav className="mb-2 flex flex-wrap gap-2 text-sm">
        {(["en", "hi", "mr"] as const).map((l) => (
          <Link key={l} href={`/help/connectors/${tool}?lang=${l}`} aria-current={l === lang ? "page" : undefined} className={l === lang ? "font-bold underline" : "underline"}>
            {l === "en" ? "English" : l === "hi" ? "हिन्दी" : "मराठी"}
          </Link>
        ))}
        <Link href="/shop/accounts/sync" className="ml-auto underline">
          {h.back}
        </Link>
      </nav>
      <h1 className="text-2xl font-bold text-ink-900">{guide.name}</h1>
      <p className="mt-1 text-sm text-ink-700">
        <b>{h.sends}:</b> {tr(guide.sends, lang)}
      </p>
      <h2 className="mt-4 text-lg font-bold">{h.to}</h2>
      <ol className="mt-1 list-decimal space-y-1 pl-6">
        {guide.toSoftware.map((s, i) => (
          <li key={i}>{tr(s, lang)}</li>
        ))}
      </ol>
      <h2 className="mt-4 text-lg font-bold">{h.from}</h2>
      <ol className="mt-1 list-decimal space-y-1 pl-6">
        {guide.fromSoftware.map((s, i) => (
          <li key={i}>{tr(s, lang)}</li>
        ))}
      </ol>
      {guide.note ? <p className="mt-4 rounded-xl bg-kesari-50 p-3 text-sm">{tr(guide.note, lang)}</p> : null}
    </article>
  );
}
