"use client";

/** Rider App v2: add or edit the rider's insurance nominee (PUT /api/delivery-partner/insurance/nominee). */
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  none: L("No nominee added yet.", "अभी कोई नॉमिनी नहीं जोड़ा गया।", "अजून नॉमिनी जोडलेला नाही."),
  add: L("Add nominee", "नॉमिनी जोड़ें", "नॉमिनी जोडा"),
  edit: L("Edit nominee", "नॉमिनी बदलें", "नॉमिनी बदला"),
  name: L("Nominee's full name", "नॉमिनी का पूरा नाम", "नॉमिनीचे पूर्ण नाव"),
  relation: L("Relation (e.g. wife, mother)", "रिश्ता (जैसे पत्नी, माँ)", "नाते (उदा. पत्नी, आई)"),
  mobile: L("Mobile number (optional)", "मोबाइल नंबर (वैकल्पिक)", "मोबाइल नंबर (ऐच्छिक)"),
  dob: L("Date of birth (optional)", "जन्म तिथि (वैकल्पिक)", "जन्मतारीख (ऐच्छिक)"),
  save: L("Save nominee", "नॉमिनी सेव करें", "नॉमिनी सेव्ह करा"),
  saving: L("Saving…", "सेव हो रहा है…", "सेव्ह होत आहे…"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  saved: L("Nominee saved.", "नॉमिनी सेव हो गया।", "नॉमिनी सेव्ह झाला."),
  failed: L("Could not save. Please check the details.", "सेव नहीं हुआ। कृपया विवरण जाँचें।", "सेव्ह झाले नाही. कृपया तपशील तपासा."),
} as const;

type Nominee = { name: string; relation: string; mobile: string | null; dateOfBirth: string | null };

export function NomineeForm({ initial, lang }: { initial: Nominee | null; lang: Lang }) {
  const [nominee, setNominee] = useState<Nominee | null>(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: initial?.name ?? "", relation: initial?.relation ?? "", mobile: initial?.mobile ?? "", dateOfBirth: initial?.dateOfBirth ?? "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/delivery-partner/insurance/nominee", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, relation: form.relation, mobile: form.mobile || null, dateOfBirth: form.dateOfBirth || null }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message ?? tr(T.failed, lang));
      }
      setNominee(payload as Nominee);
      setEditing(false);
      setMessage({ tone: "success", text: tr(T.saved, lang) });
    } catch (caught) {
      setMessage({ tone: "danger", text: caught instanceof Error ? caught.message : tr(T.failed, lang) });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Card className="p-5 text-sm" data-testid="nominee-card">
        {nominee ? (
          <dl className="space-y-1">
            <div>
              <dt className="inline text-ink-500">{tr(T.name, lang)}: </dt>
              <dd className="inline font-medium text-ink-900">{nominee.name}</dd>
            </div>
            <div>
              <dt className="inline text-ink-500">{tr(T.relation, lang)}: </dt>
              <dd className="inline text-ink-900">{nominee.relation}</dd>
            </div>
            {nominee.mobile ? (
              <div>
                <dt className="inline text-ink-500">{tr(T.mobile, lang)}: </dt>
                <dd className="inline text-ink-900">{nominee.mobile}</dd>
              </div>
            ) : null}
            {nominee.dateOfBirth ? (
              <div>
                <dt className="inline text-ink-500">{tr(T.dob, lang)}: </dt>
                <dd className="inline text-ink-900">{nominee.dateOfBirth}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-ink-600">{tr(T.none, lang)}</p>
        )}
        {message ? <div className="mt-3"><Alert tone={message.tone}>{message.text}</Alert></div> : null}
        <Button variant="secondary" className="mt-3 w-full sm:w-auto" onClick={() => setEditing(true)}>
          {nominee ? tr(T.edit, lang) : tr(T.add, lang)}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form className="space-y-4" onSubmit={submit} data-testid="nominee-form">
        <Field label={tr(T.name, lang)} error={fieldErrors.name}>
          <input className={inputClass} value={form.name} maxLength={120} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={tr(T.relation, lang)} error={fieldErrors.relation}>
          <input className={inputClass} value={form.relation} maxLength={40} required onChange={(e) => setForm({ ...form, relation: e.target.value })} />
        </Field>
        <Field label={tr(T.mobile, lang)} error={fieldErrors.mobile}>
          <input
            className={inputClass}
            value={form.mobile}
            inputMode="numeric"
            maxLength={10}
            onChange={(e) => setForm({ ...form, mobile: e.target.value.replace(/\D/g, "") })}
          />
        </Field>
        <Field label={tr(T.dob, lang)} error={fieldErrors.dateOfBirth}>
          <input type="date" className={inputClass} value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
        </Field>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy}>
            {busy ? tr(T.saving, lang) : tr(T.save, lang)}
          </Button>
          <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
            {tr(T.cancel, lang)}
          </Button>
        </div>
      </form>
    </Card>
  );
}
