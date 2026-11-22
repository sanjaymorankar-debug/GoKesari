"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { DOCTOR_SCOPE_LABEL, DOCUMENT_LEVEL_HINTS, DOCUMENT_LEVEL_LABELS, DOCUMENT_LEVELS, type DocumentLevel } from "@/lib/shop-document-rules";

export interface DocumentRulesView {
  documents: {
    key: string;
    label: string;
    kind: "seller" | "legal" | "custom";
    builtIn: boolean;
    status: "ACTIVE" | "INACTIVE";
    lawNote: string | null;
    labelHi: string | null;
    labelMr: string | null;
    needsNumber: boolean;
    needsExpiry: boolean;
    needsAuthority: boolean;
    rules: { id: string; scope: string; scopeLabel: string; level: DocumentLevel; liveShopsDueAt: string | null; note: string | null; updatedAt: string }[];
  }[];
  shopTypes: { key: string; label: string }[];
  promiseDays: number;
}

const LEVEL_TONES: Record<DocumentLevel, "danger" | "warning" | "info"> = { MUST_HAVE: "danger", PROMISE: "warning", OPTIONAL: "info" };

const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));

async function send(url: string, method: string, body?: unknown): Promise<DocumentRulesView> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work. Please try again.");
  return (payload?.data ?? payload) as DocumentRulesView;
}

/**
 * Shop documents (owner, 22-Nov-2026, DF-09): the admin decides, for every licence and legal document,
 * whether a kind of shop must have it before going live, may upload it later on the owner's promise,
 * or may add it optionally — and adds documents the law newly requires. Operators see it read-only.
 * Every change is audited.
 */
export function ShopDocumentRulesAdmin({ isAdmin, initial }: { isAdmin: boolean; initial: DocumentRulesView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<DocumentRulesView>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setView(await action());
      setNotice(done);
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const builtIn = view.documents.filter((d) => d.builtIn);
  const added = view.documents.filter((d) => !d.builtIn);

  return (
    <div className="space-y-4" data-testid="shop-document-rules">
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">How it works</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          <li>
            <strong>GST number or PAN</strong> — always a must-have for every shop (owner rule DF-08). It is not changed here.
          </li>
          {DOCUMENT_LEVELS.map((level) => (
            <li key={level}>
              <strong>{DOCUMENT_LEVEL_LABELS[level]}</strong> — {DOCUMENT_LEVEL_HINTS[level]}
            </li>
          ))}
          <li>
            A rule for one shop type wins over the &quot;Doctors&quot; rule, then the &quot;Shops that sell food&quot; rule, then the &quot;All
            shops&quot; rule. &quot;Doctors&quot; means a shop in any Health doctor category (not Therapy or Diagnostics). A document with no
            rule for a shop is not asked of it.
          </li>
          <li>
            When you make a document needed, shops already live get the days you give (default {view.promiseDays}) before they can be
            suspended for it; they are reminded by e-mail on the 1st and 15th. New shops follow the rule at once.
          </li>
        </ul>
        {!isAdmin ? <Alert tone="info">Only an admin can change these rules.</Alert> : null}
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? (
        <p className="text-sm text-leaf-700" role="status">
          {notice}
        </p>
      ) : null}

      {[...builtIn, ...added].map((doc) => (
        <DocumentCard key={doc.key} doc={doc} view={view} isAdmin={isAdmin} busy={busy} run={run} />
      ))}

      {isAdmin ? <AddDocumentForm busy={busy} run={run} /> : null}
    </div>
  );
}

type Run = (action: () => Promise<DocumentRulesView>, done: string) => Promise<boolean>;

function DocumentCard({ doc, view, isAdmin, busy, run }: { doc: DocumentRulesView["documents"][number]; view: DocumentRulesView; isAdmin: boolean; busy: boolean; run: Run }) {
  const used = new Set(doc.rules.map((r) => r.scope));
  const scopes = [
    { value: "ALL", label: "All shops" },
    { value: "FOOD", label: "Shops that sell food" },
    { value: "DOCTOR", label: DOCTOR_SCOPE_LABEL },
    ...view.shopTypes.map((t) => ({ value: `TYPE:${t.key}`, label: t.label })),
  ].filter((s) => !used.has(s.value));
  const [scope, setScope] = useState(scopes[0]?.value ?? "");
  const [level, setLevel] = useState<DocumentLevel>("PROMISE");
  const [days, setDays] = useState(view.promiseDays);
  const [editing, setEditing] = useState(false);
  const slug = doc.key.replace(/^DOC:/, "").toLowerCase();
  const editable = isAdmin && doc.status === "ACTIVE";

  return (
    <Card className="space-y-3 p-4" data-testid={`doc-rules-${slug}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-ink-900">{doc.label}</h3>
          {doc.lawNote ? <p className="text-xs text-ink-500">{doc.lawNote}</p> : null}
          {!doc.builtIn ? (
            <p className="text-xs text-ink-500">
              Asks for: {[doc.needsNumber ? "number" : null, doc.needsExpiry ? "expiry date" : null, doc.needsAuthority ? "issuing authority" : null, "a copy"].filter(Boolean).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {!doc.builtIn ? <Badge tone="neutral">Added by admin</Badge> : null}
          {doc.status === "INACTIVE" ? <Badge tone="warning">Switched off</Badge> : null}
        </div>
      </div>

      {doc.rules.length === 0 ? (
        <p className="text-sm text-ink-500">Not asked of any shop{doc.status === "ACTIVE" ? " yet — add a rule below." : "."}</p>
      ) : (
        <ul className="divide-y divide-cream-200 rounded-lg border border-cream-200">
          {doc.rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
              <div>
                <span className="font-medium text-ink-900">{rule.scopeLabel}</span>
                {rule.liveShopsDueAt && rule.level !== "OPTIONAL" ? (
                  <span className="ml-2 text-xs text-ink-500">shops already live: by {dateLabel(rule.liveShopsDueAt)}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {editable ? (
                  <select
                    className={`${inputClass} w-auto`}
                    value={rule.level}
                    disabled={busy}
                    aria-label={`${doc.label} for ${rule.scopeLabel}`}
                    onChange={(e) =>
                      run(
                        () => send("/api/admin/shop-document-rules", "PUT", { docKey: doc.key, scope: rule.scope, level: e.target.value }),
                        `${doc.label} for ${rule.scopeLabel}: ${DOCUMENT_LEVEL_LABELS[e.target.value as DocumentLevel].toLowerCase()}.`,
                      )
                    }
                  >
                    {DOCUMENT_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {DOCUMENT_LEVEL_LABELS[l]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Badge tone={LEVEL_TONES[rule.level]}>{DOCUMENT_LEVEL_LABELS[rule.level]}</Badge>
                )}
                {editable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Remove the rule "${doc.label} — ${rule.scopeLabel}"? Those shops will no longer be asked for it (unless a broader rule applies).`)) return;
                      void run(() => send(`/api/admin/shop-document-rules/${rule.id}`, "DELETE"), `Rule removed: ${doc.label} — ${rule.scopeLabel}.`);
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editable && scopes.length > 0 ? (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const label = scopes.find((s) => s.value === scope)?.label ?? scope;
            void run(
              () => send("/api/admin/shop-document-rules", "PUT", { docKey: doc.key, scope, level, liveShopDays: days }),
              `${doc.label} for ${label}: ${DOCUMENT_LEVEL_LABELS[level].toLowerCase()}.`,
            );
          }}
        >
          <Field label="Add a rule for">
            <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)} aria-label={`Who needs ${doc.label}`}>
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How">
            <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value as DocumentLevel)} aria-label={`How ${doc.label} is needed`}>
              {DOCUMENT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {DOCUMENT_LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Live shops get (days)">
            <input
              className={`${inputClass} w-24`}
              type="number"
              min={7}
              max={365}
              value={days}
              disabled={level === "OPTIONAL"}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Days shops already live get"
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy || !scope}>
            Add rule
          </Button>
        </form>
      ) : null}

      {isAdmin && !doc.builtIn ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Edit document"}
          </Button>
          <Button
            size="sm"
            variant={doc.status === "ACTIVE" ? "ghost" : "secondary"}
            disabled={busy}
            onClick={() => {
              const off = doc.status === "ACTIVE";
              if (off && !window.confirm(`Switch off ${doc.label}? No shop will be asked for it any more; what shops uploaded is kept.`)) return;
              void run(
                () => send(`/api/admin/shop-document-types/${encodeURIComponent(doc.key)}`, "PATCH", { status: off ? "INACTIVE" : "ACTIVE" }),
                off ? `${doc.label} switched off.` : `${doc.label} switched on.`,
              );
            }}
          >
            {doc.status === "ACTIVE" ? "Switch off" : "Switch on"}
          </Button>
        </div>
      ) : null}
      {editing ? <DocumentFields doc={doc} busy={busy} run={run} onDone={() => setEditing(false)} /> : null}
    </Card>
  );
}

function DocumentFields({
  doc,
  busy,
  run,
  onDone,
}: {
  doc?: DocumentRulesView["documents"][number];
  busy: boolean;
  run: Run;
  onDone?: () => void;
}) {
  const [label, setLabel] = useState(doc?.label ?? "");
  const [labelHi, setLabelHi] = useState(doc?.labelHi ?? "");
  const [labelMr, setLabelMr] = useState(doc?.labelMr ?? "");
  const [lawNote, setLawNote] = useState(doc?.lawNote ?? "");
  const [needsNumber, setNeedsNumber] = useState(doc?.needsNumber ?? true);
  const [needsExpiry, setNeedsExpiry] = useState(doc?.needsExpiry ?? false);
  const [needsAuthority, setNeedsAuthority] = useState(doc?.needsAuthority ?? false);
  const body = { label, labelHi: labelHi || null, labelMr: labelMr || null, lawNote, needsNumber, needsExpiry, needsAuthority };

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      data-testid={doc ? "edit-document-form" : "add-document-form"}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            doc
              ? send(`/api/admin/shop-document-types/${encodeURIComponent(doc.key)}`, "PATCH", body)
              : send("/api/admin/shop-document-types", "POST", body),
          doc ? `${label} saved.` : `${label} added. Now add a rule: which shops need it, and how.`,
        ).then((saved) => {
          if (saved) onDone?.();
        });
      }}
    >
      <Field label="Name of the document" hint="As shop owners will see it, e.g. Pollution control NOC">
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required aria-label="Name of the document" />
      </Field>
      <Field label="Which law, or why it is needed" hint="Shown to shop owners and reviewers">
        <input className={inputClass} value={lawNote} onChange={(e) => setLawNote(e.target.value)} maxLength={300} required aria-label="Which law, or why it is needed" />
      </Field>
      <Field label="Name in Hindi (optional)">
        <input className={inputClass} value={labelHi} onChange={(e) => setLabelHi(e.target.value)} maxLength={120} aria-label="Name in Hindi" />
      </Field>
      <Field label="Name in Marathi (optional)">
        <input className={inputClass} value={labelMr} onChange={(e) => setLabelMr(e.target.value)} maxLength={120} aria-label="Name in Marathi" />
      </Field>
      <fieldset className="space-y-1 text-sm sm:col-span-2">
        <legend className="font-medium text-ink-700">The upload form asks for (a copy is always required)</legend>
        <label className="mr-4 inline-flex items-center gap-2">
          <input type="checkbox" checked={needsNumber} onChange={(e) => setNeedsNumber(e.target.checked)} /> Number on the document
        </label>
        <label className="mr-4 inline-flex items-center gap-2">
          <input type="checkbox" checked={needsExpiry} onChange={(e) => setNeedsExpiry(e.target.checked)} /> Expiry date
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={needsAuthority} onChange={(e) => setNeedsAuthority(e.target.checked)} /> Issuing authority
        </label>
      </fieldset>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || label.trim().length < 3 || lawNote.trim().length < 5}>
          {doc ? "Save" : "Add document"}
        </Button>
      </div>
    </form>
  );
}

function AddDocumentForm({ busy, run }: { busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-ink-900">Add a document</h2>
          <p className="text-sm text-ink-500">When a law starts requiring a licence or registration that is not in the list above.</p>
        </div>
        <Button size="sm" variant={open ? "ghost" : "primary"} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Add a document"}
        </Button>
      </div>
      {open ? <DocumentFields key="new" busy={busy} run={run} onDone={() => setOpen(false)} /> : null}
    </Card>
  );
}
