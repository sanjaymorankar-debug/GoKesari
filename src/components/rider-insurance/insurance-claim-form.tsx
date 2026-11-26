"use client";

/**
 * Rider App v2: raise an insurance claim. POST /api/delivery-partner/insurance/claim opens a
 * help-desk ticket; photos / PDFs then go on it through the ticket's own upload. Shows the
 * ticket reference and a link to follow it.
 */
import Link from "next/link";
import { useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  intro: L(
    "Tell us what happened. Our team will help you with the insurer's claim. Attach the hospital bills, reports or FIR if you have them.",
    "बताइए क्या हुआ। हमारी टीम बीमा कंपनी के क्लेम में आपकी मदद करेगी। अस्पताल के बिल, रिपोर्ट या FIR हों तो जोड़ें।",
    "काय झाले ते सांगा. आमची टीम विमा कंपनीच्या क्लेममध्ये तुम्हाला मदत करेल. रुग्णालयाची बिले, अहवाल किंवा FIR असल्यास जोडा.",
  ),
  date: L("Date of incident", "घटना की तारीख", "घटनेची तारीख"),
  what: L("What happened?", "क्या हुआ?", "काय झाले?"),
  files: L("Documents (photos or PDF, optional)", "दस्तावेज़ (फ़ोटो या PDF, वैकल्पिक)", "कागदपत्रे (फोटो किंवा PDF, ऐच्छिक)"),
  submit: L("Raise claim", "क्लेम करें", "क्लेम करा"),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहोत…"),
  tooShort: L("Please describe what happened in a bit more detail.", "कृपया थोड़ा और विस्तार से बताएँ क्या हुआ।", "कृपया काय झाले ते थोडे अधिक सविस्तर सांगा."),
  failed: L("Could not raise the claim. Please try again.", "क्लेम नहीं हो सका। कृपया फिर से कोशिश करें।", "क्लेम करता आला नाही. कृपया पुन्हा प्रयत्न करा."),
  done: L("Claim raised. Your reference: {r}", "क्लेम दर्ज हो गया। आपका संदर्भ: {r}", "क्लेम नोंदवला. तुमचा संदर्भ: {r}"),
  fileFailed: L("Some files could not be attached; add them on the ticket.", "कुछ फ़ाइलें नहीं जुड़ सकीं; उन्हें टिकट पर जोड़ें।", "काही फायली जोडता आल्या नाहीत; त्या तिकिटावर जोडा."),
  follow: L("Follow the claim", "क्लेम देखें", "क्लेम पाहा"),
} as const;

export function InsuranceClaimForm({ lang }: { lang: Lang }) {
  const [incidentDate, setIncidentDate] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; ticketNumber: string; fileProblem: boolean } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (description.trim().length < 10) return setError(tr(T.tooShort, lang));
    setBusy(true);
    try {
      const res = await fetch("/api/delivery-partner/insurance/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim(), incidentDate: incidentDate || null }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.id) throw new Error(payload?.error?.message ?? tr(T.failed, lang));
      let fileProblem = false;
      for (const file of files) {
        try {
          const form = new FormData();
          const body = file.type.startsWith("image/") ? await shrinkImage(file) : file;
          form.append("file", body, file.name);
          const up = await fetch(`/api/support/tickets/${payload.id}/attachments`, { method: "POST", body: form });
          if (!up.ok) fileProblem = true;
        } catch {
          fileProblem = true;
        }
      }
      setDone({ id: payload.id, ticketNumber: String(payload.ticketNumber), fileProblem });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.failed, lang));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card className="space-y-3 p-5" data-testid="insurance-claim-done">
        <Alert tone="success">{tr(T.done, lang).replace("{r}", done.ticketNumber)}</Alert>
        {done.fileProblem ? <Alert tone="warning">{tr(T.fileFailed, lang)}</Alert> : null}
        <Link href={`/support/${done.id}`} className="inline-flex min-h-11 items-center font-medium text-kesari-700 underline">
          {tr(T.follow, lang)}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form className="space-y-4" onSubmit={submit} data-testid="insurance-claim-form">
        <p className="text-sm text-ink-600">{tr(T.intro, lang)}</p>
        <Field label={tr(T.date, lang)}>
          <input type="date" className={inputClass} value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} />
        </Field>
        <Field label={tr(T.what, lang)}>
          <textarea className={inputClass} rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={tr(T.files, lang)}>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="block w-full text-sm"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))}
          />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {busy ? tr(T.sending, lang) : tr(T.submit, lang)}
        </Button>
      </form>
    </Card>
  );
}
