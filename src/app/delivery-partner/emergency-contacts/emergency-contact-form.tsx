"use client";

import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  name: L("Name", "नाम", "नाव"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  relation: L("Relation (e.g. father, wife)", "रिश्ता (जैसे पिता, पत्नी)", "नाते (उदा. वडील, पत्नी)"),
  save: L("Save", "सेव करें", "सेव्ह करा"),
  saving: L("Saving…", "सेव हो रहा है…", "सेव्ह होत आहे…"),
  saved: L("Saved.", "सेव हो गया।", "सेव्ह झाले."),
  failed: L("Could not save. Please check the details.", "सेव नहीं हुआ। कृपया विवरण जाँचें।", "सेव्ह झाले नाही. कृपया तपशील तपासा."),
} as const;

export function EmergencyContactForm({ initial, lang }: { initial: { name: string; mobile: string; relation: string }; lang: Lang }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/delivery-partner/emergency-contact", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, mobile: form.mobile, relation: form.relation || null }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message ?? tr(T.failed, lang));
      }
      setMessage({ tone: "success", text: tr(T.saved, lang) });
    } catch (caught) {
      setMessage({ tone: "danger", text: caught instanceof Error ? caught.message : tr(T.failed, lang) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <form className="space-y-4" onSubmit={submit} data-testid="emergency-contact-form">
        <Field label={tr(T.name, lang)} error={fieldErrors.name}>
          <input className={inputClass} value={form.name} maxLength={120} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={tr(T.mobile, lang)} error={fieldErrors.mobile}>
          <input
            className={inputClass}
            value={form.mobile}
            inputMode="numeric"
            maxLength={10}
            required
            onChange={(e) => setForm({ ...form, mobile: e.target.value.replace(/\D/g, "") })}
          />
        </Field>
        <Field label={tr(T.relation, lang)} error={fieldErrors.relation}>
          <input className={inputClass} value={form.relation} maxLength={40} onChange={(e) => setForm({ ...form, relation: e.target.value })} />
        </Field>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {busy ? tr(T.saving, lang) : tr(T.save, lang)}
        </Button>
      </form>
    </Card>
  );
}
