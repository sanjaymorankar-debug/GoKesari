"use client";

/**
 * docs/dealer-platform phase 5: the chosen scheme's own questions on the application (custom fields), shown or
 * hidden by their conditions. Answers are saved here; required ones and the scheme's conditions are checked on
 * submit. FILE questions upload straight away; FORMULA fields are worked out, not asked.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { fieldVisible, type CustomField, type CustomValues } from "@/lib/dealer-schemes";

export function SchemeQuestions({ fields, values: initial, files, editable }: { fields: CustomField[]; values: CustomValues; files: { id: string; fieldKey: string; fileName: string }[]; editable: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState<CustomValues>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = fields.filter((f) => f.type !== "FORMULA");
  if (!asked.length) return null;
  const set = (key: string, v: CustomValues[string]) => setValues((x) => ({ ...x, [key]: v }));

  async function save() {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dealer/application/custom-fields", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not save.");
      setNotice("Answers saved.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(key: string, file: File) {
    setBusy(`file-${key}`);
    setError(null);
    try {
      const form = new FormData();
      form.append("key", key);
      form.append("file", file, file.name);
      const res = await fetch("/api/dealer/application/custom-fields/file", { method: "POST", body: form });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not upload.");
      setNotice("File uploaded.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="dealer-scheme-questions">
      <h2 className="text-base font-bold text-ink-900">Questions for your scheme</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {asked.filter((f) => fieldVisible(f, values)).map((f) => {
          const label = `${f.label}${f.required ? " *" : ""}`;
          const v = values[f.key];
          const common = { disabled: !editable, "aria-describedby": f.help ? `help-${f.key}` : undefined };
          let input: React.ReactNode;
          switch (f.type) {
            case "DROPDOWN":
              input = (
                <select className={inputClass} value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value || null)} {...common}>
                  <option value="">Choose…</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              );
              break;
            case "MULTI_SELECT":
              input = (
                <div className="flex flex-wrap gap-3">
                  {f.options?.map((o) => (
                    <label key={o} className="flex min-h-11 items-center gap-1 text-sm">
                      <input type="checkbox" disabled={!editable} checked={Array.isArray(v) && v.includes(o)} onChange={(e) => set(f.key, e.target.checked ? [...(Array.isArray(v) ? v : []), o] : (Array.isArray(v) ? v : []).filter((x) => x !== o))} />
                      {o}
                    </label>
                  ))}
                </div>
              );
              break;
            case "CHECKBOX":
            case "YES_NO":
              input = f.type === "CHECKBOX" ? (
                <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!editable} checked={v === true} onChange={(e) => set(f.key, e.target.checked)} /> Yes</label>
              ) : (
                <select className={inputClass} value={v === true ? "yes" : v === false ? "no" : ""} onChange={(e) => set(f.key, e.target.value === "" ? null : e.target.value === "yes")} {...common}>
                  <option value="">Choose…</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              );
              break;
            case "FILE": {
              const file = files.find((x) => x.fieldKey === f.key);
              input = (
                <div className="space-y-1 text-sm">
                  {file ? <p>Uploaded: {file.fileName}</p> : <p className="text-ink-600">Not uploaded yet.</p>}
                  {editable ? <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy !== null} onChange={(e) => e.target.files?.[0] && upload(f.key, e.target.files[0])} /> : null}
                </div>
              );
              break;
            }
            case "CURRENCY":
              input = <input className={inputClass} inputMode="decimal" value={typeof v === "number" ? v / 100 : ""} onChange={(e) => set(f.key, e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))} {...common} />;
              break;
            case "PERCENT":
              input = <input className={inputClass} inputMode="decimal" value={typeof v === "number" ? v / 100 : ""} onChange={(e) => set(f.key, e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))} {...common} />;
              break;
            case "NUMBER":
              input = <input className={inputClass} inputMode="decimal" value={typeof v === "number" ? v : ""} onChange={(e) => set(f.key, e.target.value === "" ? null : Number(e.target.value))} {...common} />;
              break;
            case "DATE":
              input = <input className={inputClass} type="date" value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value || null)} {...common} />;
              break;
            default:
              input = <input className={inputClass} value={typeof v === "string" ? v : ""} maxLength={500} onChange={(e) => set(f.key, e.target.value)} {...common} />;
          }
          return (
            <Field key={f.key} label={f.type === "CURRENCY" ? `${label} (₹)` : f.type === "PERCENT" ? `${label} (%)` : label}>
              {input}
              {f.help ? <p id={`help-${f.key}`} className="mt-1 text-xs text-ink-600">{f.help}</p> : null}
            </Field>
          );
        })}
      </div>
      {editable ? (
        <Button disabled={busy !== null} onClick={save}>
          {busy === "save" ? "Saving…" : "Save answers"}
        </Button>
      ) : null}
    </Card>
  );
}
