"use client";

/**
 * Review and e-sign the shop's personalised agreements (docs/seller-agreements-2026-11, brief §2–§3).
 * Used by the registration Agreements step, Seller Central → My Agreements and the owner signing link.
 *
 * - Each document is the shop's own copy (not the blank template), in English / मराठी / हिंदी, with Download PDF.
 * - Each tick box starts unticked and is enabled only once that document has been scrolled to the end.
 * - Signature: full name + designation + the SMS code sent to the registered mobile.
 * - Staff / the dealer who registered the shop can only send the owner a signing link.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { AGREEMENT_REASON_TEXT } from "@/lib/seller-agreements";

type Lang = "en" | "mr" | "hi";
type DocStatus = { docType: "SELLER_SLA" | "MEDICAL_ONBOARDING"; version: string; title: string; languages: Lang[]; signed: boolean; lastSignedVersion: string | null };
type HistoryItem = { id: string; title: string; version: string; signedAtIst: string; verifyCode: string; files: { id: string; language: Lang; sha256: string }[] };
type View = {
  enabled: boolean;
  shopName: string;
  sellerId: string | null;
  required: boolean;
  reason: "REGISTRATION" | "EXISTING_SHOP" | "NEW_VERSION" | "ANNEXURE_UPDATE" | null;
  documents: DocStatus[];
  blockers: string[];
  graceUntil: string | null;
  overdue: boolean;
  noPublishedDocuments: boolean;
  history: HistoryItem[];
  pendingOwnerLink: { sentAt: string | null; expiresAt: string | null; by: string } | null;
  maskedMobile: string | null;
  viewer: "OWNER" | "STAFF";
  canSign: boolean;
  defaults: { signerName: string; constitution: Constitution | null; designation: Designation; pharmacistNeeded: boolean } | null;
};
type Constitution = "PROPRIETORSHIP" | "PARTNERSHIP" | "LLP" | "COMPANY";
type Designation = "PROPRIETOR" | "PARTNER" | "DIRECTOR";

const LANG_LABEL: Record<Lang, string> = { en: "English", mr: "मराठी", hi: "हिंदी" };
const CONSTITUTION_LABEL: Record<Constitution, string> = { PROPRIETORSHIP: "Sole proprietorship", PARTNERSHIP: "Partnership firm", LLP: "LLP", COMPANY: "Company" };
const DESIGNATION_LABEL: Record<Designation, string> = { PROPRIETOR: "Proprietor", PARTNER: "Partner", DIRECTOR: "Director" };

const REASON_TEXT = AGREEMENT_REASON_TEXT;

const istFmt = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => null)) as { data?: T; error?: { message?: string } } | T | null;
  if (!response.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? "Something went wrong. Please try again.");
  return ((body as { data?: T })?.data ?? body) as T;
}

function DocumentViewer({ src, onReadToEnd }: { src: string; onReadToEnd: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A new src remounts the viewer (key), so there is no stale state to clear here.
    let cancelled = false;
    fetch(src)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Could not load the document.");
        return r.text();
      })
      .then((text) => !cancelled && setHtml(text))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [src]);

  const attach = useCallback(() => {
    const win = frame.current?.contentWindow;
    const doc = frame.current?.contentDocument;
    if (!win || !doc) return;
    const check = () => {
      const el = doc.scrollingElement ?? doc.documentElement;
      if (el.scrollTop + win.innerHeight >= el.scrollHeight - 40) onReadToEnd();
    };
    win.addEventListener("scroll", check, { passive: true });
    check();
  }, [onReadToEnd]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (html === null) return <div className="flex h-[60vh] items-center justify-center rounded-lg border border-cream-200 bg-white text-sm text-ink-500">Preparing your document…</div>;
  return (
    <iframe
      ref={frame}
      title="Agreement"
      // Same origin so the page can tell when the reader reached the end; scripts never run inside.
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={attach}
      className="h-[60vh] w-full rounded-lg border border-cream-200 bg-white"
    />
  );
}

export function AgreementsSigner({
  apiBase,
  onSigned,
  registrationAccept = false,
}: {
  apiBase: string;
  onSigned?: () => void;
  /**
   * Onboarding v2 shop registration (owner, 27-Nov-2026): accept with the ticks and the typed name, no SMS code.
   * Everywhere else (the shop dashboard's review, owner links) the code is asked as before.
   */
  registrationAccept?: boolean;
}) {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const [active, setActive] = useState(0);
  const [read, setRead] = useState<Record<string, boolean>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [constitution, setConstitution] = useState<Constitution>("PROPRIETORSHIP");
  const [designation, setDesignation] = useState<Designation>("PROPRIETOR");
  const [pharmacistName, setPharmacistName] = useState("");
  const [pharmacistReg, setPharmacistReg] = useState("");
  const [shareLocation, setShareLocation] = useState(false);
  const [policies, setPolicies] = useState(false);
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await call<View>(apiBase);
      setView(v);
      if (v.defaults) {
        setName((n) => n || v.defaults!.signerName);
        if (v.defaults.constitution) setConstitution(v.defaults.constitution);
        setDesignation(v.defaults.designation);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [apiBase]);
  useEffect(() => {
    // Loads the view once on mount (and when the API changes); setState runs after the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toSign = useMemo(() => view?.documents.filter((d) => !d.signed) ?? [], [view]);
  const current = toSign[active];
  const docLang: Lang = current && current.languages.includes(lang) ? lang : "en";
  const previewBase = apiBase.replace(/\/?$/, "") + "/preview";
  const params = (doc: DocStatus, l: Lang, format: "html" | "pdf") => {
    const q = new URLSearchParams({ doc: doc.docType, lang: l, format, constitution, designation, name });
    if (pharmacistName && pharmacistReg) {
      q.set("pharmacistName", pharmacistName);
      q.set("pharmacistReg", pharmacistReg);
    }
    return `${previewBase}?${q.toString()}`;
  };

  // The viewer re-renders when the signer's choices change; read status is kept per document.
  const [debounced, setDebounced] = useState({ name, constitution, designation, pharmacistName, pharmacistReg });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ name, constitution, designation, pharmacistName, pharmacistReg }), 600);
    return () => clearTimeout(t);
  }, [name, constitution, designation, pharmacistName, pharmacistReg]);
  const viewerSrc = current ? params(current, docLang, "html") : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableSrc = useMemo(() => viewerSrc, [current?.docType, docLang, debounced]);

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!view) return <p className="text-sm text-ink-500">Loading your agreements…</p>;
  if (!view.enabled || view.noPublishedDocuments) {
    return <Alert tone="info">No agreement needs your signature right now.</Alert>;
  }

  const allTicked = toSign.every((d) => ticked[d.docType]) && policies;
  const pharmacistNeeded = Boolean(view.defaults?.pharmacistNeeded);
  const formOk = name.trim().length >= 3 && (!pharmacistNeeded || (pharmacistName.trim().length >= 3 && pharmacistReg.trim().length >= 2));

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const sent = await call<{ maskedPhone: string }>(apiBase, { method: "POST", body: JSON.stringify({ action: "otp" }) });
      setCodeSentTo(sent.maskedPhone);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function position(): Promise<{ lat: number; lng: number; accuracyM?: number } | null> {
    if (!shareLocation || !("geolocation" in navigator)) return null;
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
        () => resolve(null),
        { timeout: 8000 },
      ),
    );
  }

  async function sign() {
    setBusy(true);
    setError(null);
    setNotice("Signing and preparing your signed copies in English, मराठी and हिंदी… this can take up to a minute.");
    try {
      await call(apiBase, {
        method: "POST",
        body: JSON.stringify({
          action: registrationAccept ? "accept" : "sign",
          ...(registrationAccept ? {} : { code }),
          signerName: name,
          designation,
          constitution,
          pharmacist: pharmacistNeeded ? { name: pharmacistName, registrationNumber: pharmacistReg } : null,
          accepted: toSign.map((d) => ({ docType: d.docType, version: d.version, scrolledToEnd: true })),
          languageViewed: lang,
          acceptPolicies: policies,
          geo: await position(),
        }),
      });
      setNotice("Signed. Your signed copies are below and will be e-mailed to you.");
      setCode("");
      setCodeSentTo(null);
      setTicked({});
      await load();
      onSigned?.();
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ expiresAt: string }>(apiBase, { method: "POST", body: JSON.stringify({ action: "link" }) });
      setNotice(`Signing link sent to the owner by SMS, WhatsApp and e-mail (valid until ${istFmt(r.expiresAt)}). The shop gets no orders until the owner signs.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="agreements-signer">
      {view.required ? (
        <Alert tone={view.overdue ? "danger" : "warning"} title={`Agreements to sign – ${view.shopName}`}>
          {view.reason ? REASON_TEXT[view.reason] : null}
          {view.graceUntil && view.reason !== "REGISTRATION" ? (
            <span className="block">
              {view.overdue ? "The grace period ended on " : "Sign by "}
              <strong>{istFmt(view.graceUntil)}</strong>
              {view.overdue ? ": your shop can't accept new orders until you sign." : " – after that your shop can't accept new orders until you sign."}
            </span>
          ) : null}
          {view.pendingOwnerLink ? <span className="block">Pending owner acceptance: a signing link was sent to the owner{view.pendingOwnerLink.sentAt ? ` on ${istFmt(view.pendingOwnerLink.sentAt)}` : ""}.</span> : null}
        </Alert>
      ) : (
        <Alert tone="success" title="All agreements are signed">Your signed copies are listed below.</Alert>
      )}

      {view.required && view.blockers.length > 0 ? (
        <Alert tone="danger" title="Upload these licences before you can sign">
          <ul className="list-disc pl-5">{view.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <a className="mt-1 inline-block font-medium text-kesari-700 underline" href="/shop/legal-documents">Upload licences →</a>
        </Alert>
      ) : null}

      {view.required && view.blockers.length === 0 && toSign.length > 0 ? (
        <Card className="space-y-4">
          {view.canSign ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Your full name (as signature)">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-testid="signer-name" />
              </Field>
              <Field label="Business type">
                <select className={inputClass} value={constitution} onChange={(e) => setConstitution(e.target.value as Constitution)}>
                  {(Object.keys(CONSTITUTION_LABEL) as Constitution[]).map((c) => <option key={c} value={c}>{CONSTITUTION_LABEL[c]}</option>)}
                </select>
              </Field>
              <Field label="Your designation">
                <select className={inputClass} value={designation} onChange={(e) => setDesignation(e.target.value as Designation)} data-testid="signer-designation">
                  {(Object.keys(DESIGNATION_LABEL) as Designation[]).map((d) => <option key={d} value={d}>{DESIGNATION_LABEL[d]}</option>)}
                </select>
              </Field>
              {pharmacistNeeded ? (
                <>
                  <Field label="Registered pharmacist's name">
                    <input className={inputClass} value={pharmacistName} onChange={(e) => setPharmacistName(e.target.value)} />
                  </Field>
                  <Field label="Pharmacist registration no.">
                    <input className={inputClass} value={pharmacistReg} onChange={(e) => setPharmacistReg(e.target.value)} />
                  </Field>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink-700">Language:</span>
            {(["en", "mr", "hi"] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`rounded-full border px-3 py-1 text-sm ${lang === l ? "border-kesari-600 bg-kesari-50 text-kesari-800" : "border-cream-200 text-ink-700"}`}
                aria-pressed={lang === l}
              >
                {LANG_LABEL[l]}
              </button>
            ))}
          </div>
          {current && !current.languages.includes(lang) ? (
            <p className="text-xs text-ink-500">This document is not yet published in {LANG_LABEL[lang]} (translation pending legal review); showing English.</p>
          ) : null}

          {toSign.length > 1 ? (
            <div className="flex flex-wrap gap-2" role="tablist">
              {toSign.map((d, i) => (
                <button key={d.docType} role="tab" aria-selected={i === active} type="button" onClick={() => setActive(i)} className={`rounded-lg border px-3 py-1.5 text-sm ${i === active ? "border-kesari-600 bg-kesari-50" : "border-cream-200"}`}>
                  {i + 1}. {d.title} {ticked[d.docType] ? "✓" : ""}
                </button>
              ))}
            </div>
          ) : null}

          {current && stableSrc ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink-900">{current.title} <span className="font-normal text-ink-500">v{current.version}</span></h2>
                <a className="text-sm font-medium text-kesari-700 underline" href={params(current, docLang, "pdf")}>Download PDF</a>
              </div>
              <DocumentViewer key={stableSrc} src={stableSrc} onReadToEnd={() => setRead((r) => (r[current.docType] ? r : { ...r, [current.docType]: true }))} />
            </div>
          ) : null}

          {view.canSign ? (
            <div className="space-y-2">
              {toSign.map((d) => (
                <label key={d.docType} className={`flex items-start gap-2 text-sm ${read[d.docType] ? "text-ink-900" : "text-ink-500"}`}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={Boolean(ticked[d.docType])}
                    disabled={!read[d.docType]}
                    onChange={(e) => setTicked((t) => ({ ...t, [d.docType]: e.target.checked }))}
                    data-testid={`accept-${d.docType}`}
                  />
                  <span>
                    I have read and accept the {d.title} (v{d.version}) prepared for <strong>{view.shopName}</strong>.
                    {!read[d.docType] ? <em className="block text-xs">Scroll to the end of this document to enable the tick box.</em> : null}
                  </span>
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm text-ink-900">
                <input type="checkbox" className="mt-1" checked={policies} onChange={(e) => setPolicies(e.target.checked)} data-testid="accept-policies" />
                <span>
                  I accept the{" "}
                  <a href="/legal/seller-terms" target="_blank" rel="noopener" className="underline">Seller Terms</a>,{" "}
                  <a href="/legal/terms" target="_blank" rel="noopener" className="underline">Terms of Use</a> and{" "}
                  <a href="/legal/privacy-policy" target="_blank" rel="noopener" className="underline">Privacy Policy</a> of gokesari.com.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink-700">
                <input type="checkbox" className="mt-1" checked={shareLocation} onChange={(e) => setShareLocation(e.target.checked)} />
                <span>Record my location with the signature (optional).</span>
              </label>

              {registrationAccept ? (
                <div className="rounded-lg bg-cream-50 p-3 text-sm">
                  <p className="mb-2 text-ink-700">
                    By pressing Accept you accept these agreements with your name above as your signature. Signed copies in English, मराठी and हिंदी are
                    e-mailed to you with your welcome kit.
                  </p>
                  <Button disabled={busy || !allTicked || !formOk} onClick={sign} data-testid="accept-agreements">
                    Accept the agreements
                  </Button>
                  {!allTicked ? <p className="mt-1 text-xs text-ink-500">Tick every document above to continue.</p> : null}
                </div>
              ) : (
              <div className="rounded-lg bg-cream-50 p-3 text-sm">
                <p className="mb-2 text-ink-700">
                  Sign with the one-time code sent to your registered mobile{view.maskedMobile ? ` (${view.maskedMobile})` : ""}. This is your electronic signature under the Information Technology Act, 2000.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <Button variant="secondary" disabled={busy || !allTicked || !formOk} onClick={sendCode} data-testid="send-code">
                    {codeSentTo ? "Send a new code" : "Send code"}
                  </Button>
                  {codeSentTo ? (
                    <>
                      <input
                        className={`${inputClass} w-32`}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="Code"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                        data-testid="otp-code"
                      />
                      <Button disabled={busy || code.length < 4 || !allTicked || !formOk} onClick={sign} data-testid="sign-agreements">
                        Sign and accept
                      </Button>
                    </>
                  ) : null}
                </div>
                {codeSentTo ? <p className="mt-1 text-xs text-ink-500">Code sent to {codeSentTo}.</p> : null}
                {!allTicked ? <p className="mt-1 text-xs text-ink-500">Tick every document above to continue.</p> : null}
              </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink-700">Only the shop owner can sign. Send them a link to review these documents and sign with their own OTP.</p>
              <Button disabled={busy} onClick={sendLink} data-testid="send-owner-link">Send signing link to the owner</Button>
            </div>
          )}
        </Card>
      ) : null}

      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {view.history.length > 0 ? (
        <Card className="space-y-3">
          <h2 className="text-base font-semibold text-ink-900">My Agreements</h2>
          <ul className="divide-y divide-cream-200">
            {view.history.map((h) => (
              <li key={h.id} className="py-2 text-sm">
                <div className="font-medium text-ink-900">{h.title} <span className="font-normal text-ink-500">v{h.version}</span></div>
                <div className="text-ink-600">Signed {h.signedAtIst}</div>
                <div className="mt-1 flex flex-wrap gap-3">
                  {h.files.map((f) => (
                    <a key={f.id} className="font-medium text-kesari-700 underline" href={`/api/agreements/files/${f.id}`}>
                      Download PDF ({LANG_LABEL[f.language]})
                    </a>
                  ))}
                  <a className="text-ink-600 underline" href={`/agreements/verify/${h.verifyCode}`}>Verify ({h.verifyCode})</a>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
