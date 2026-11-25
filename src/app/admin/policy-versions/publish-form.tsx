"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { inputClass } from "@/components/ui";
import { POLICY_DOC_LABEL, POLICY_DOC_SLUGS, type PolicyDocSlug } from "@/lib/policy-reconsent";

/** docs/policy-reconsent-2026-11: publish a new policy version (administrators only). */
export function PublishPolicyVersionForm({ today }: { today: string }) {
  const router = useRouter();
  const [doc, setDoc] = useState<PolicyDocSlug>("terms");
  const [version, setVersion] = useState(today);
  const [en, setEn] = useState("");
  const [hi, setHi] = useState("");
  const [mr, setMr] = useState("");
  const [requiresAcceptance, setRequiresAcceptance] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/policy-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, version, summary: { en, hi, mr }, requiresAcceptance, reason }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ ok: false, text: body?.error?.message ?? "Could not publish the version." });
        return;
      }
      setMessage({ ok: true, text: `Published ${POLICY_DOC_LABEL[doc].en} ${version}.` });
      setEn("");
      setHi("");
      setMr("");
      setReason("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-3 text-sm" data-testid="policy-publish-form">
      <label className="grid gap-1">
        <span className="font-medium">Document</span>
        <select value={doc} onChange={(e) => setDoc(e.target.value as PolicyDocSlug)} className={inputClass} name="doc">
          {POLICY_DOC_SLUGS.map((slug) => (
            <option key={slug} value={slug}>
              {POLICY_DOC_LABEL[slug].en}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Version (the policy page&apos;s &quot;Last updated&quot; date)</span>
        <input value={version} onChange={(e) => setVersion(e.target.value)} className={inputClass} name="version" placeholder="2026-12-01" required />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">What changed (English, shown to users)</span>
        <textarea value={en} onChange={(e) => setEn(e.target.value)} className={inputClass} name="summaryEn" rows={3} required maxLength={2000} />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">What changed — Hindi (optional; English is shown when blank)</span>
        <textarea value={hi} onChange={(e) => setHi(e.target.value)} className={inputClass} name="summaryHi" rows={2} maxLength={2000} lang="hi" />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">What changed — Marathi (optional)</span>
        <textarea value={mr} onChange={(e) => setMr(e.target.value)} className={inputClass} name="summaryMr" rows={2} maxLength={2000} lang="mr" />
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={requiresAcceptance} onChange={(e) => setRequiresAcceptance(e.target.checked)} className="mt-1" name="requiresAcceptance" />
        <span>
          Users must accept this version. Untick for a minor edit (typo, contact details): the version is recorded but nobody is asked again.
        </span>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Reason (audit log)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} name="reason" required maxLength={500} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-kesari-600 px-4 py-2 font-medium text-white hover:bg-kesari-800 disabled:opacity-50">
          {busy ? "Publishing…" : "Publish version"}
        </button>
        {message ? (
          <p role="status" className={message.ok ? "text-green-700" : "text-red-700"}>
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
