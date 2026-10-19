"use client";

/**
 * Raise a help desk ticket (F6.3.3, batch-2026-10 WS-C) — from an order or
 * the support portal, by a customer or a shop owner. Category, what
 * happened, and optional photos or PDFs (uploaded once the ticket exists).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { TICKET_CATEGORY_LABELS, type TicketCategory } from "@/lib/support-ticket-states";

export function TicketForm({
  categories,
  orderId,
  orderLabel,
  shopId,
  detailBase,
}: {
  categories: TicketCategory[];
  orderId?: string | null;
  orderLabel?: string | null;
  shopId?: string | null;
  /** Where the new ticket opens: "/support" or "/shop/support". */
  detailBase: string;
}) {
  const router = useRouter();
  const [category, setCategory] = useState<TicketCategory | "">(orderId ? "ORDER" : "");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!category) return setError("Choose what this is about.");
    if (subject.trim().length < 3) return setError("Enter a subject.");
    if (description.trim().length < 10) return setError("Describe the problem in a bit more detail.");
    setBusy(true);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, subject: subject.trim(), description: description.trim(), orderId: orderId ?? null, shopId: shopId ?? null }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not raise the ticket.");
      for (const file of files) {
        const form = new FormData();
        const body = file.type.startsWith("image/") ? await shrinkImage(file) : file;
        form.append("file", body, file.name);
        await fetch(`/api/support/tickets/${payload.id}/attachments`, { method: "POST", body: form });
      }
      router.push(`${detailBase}/${payload.id}?created=1`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not raise the ticket.");
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <form className="space-y-4" onSubmit={submit} data-testid="ticket-form">
        {orderLabel ? <p className="text-sm text-ink-600">About order <strong>{orderLabel}</strong></p> : null}
        <Field label="What is it about?">
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            <option value="">Choose</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {TICKET_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject">
          <input className={inputClass} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What happened?" hint="The more detail, the faster we can help.">
          <textarea className={inputClass} rows={5} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Photos or PDF (optional)" hint="Up to 5 files.">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            className="block w-full text-sm"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))}
          />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Raise ticket"}
        </Button>
      </form>
    </Card>
  );
}
