"use client";

/**
 * Review & correction screen (docs/inventory-accounting-2026-10, Part 6).
 *
 * The original bill on one side, the extracted, editable table on the other
 * (on a phone: one at a time, with a switch). Every field shows how sure the
 * reader was — low-confidence values on an amber background, fields with an
 * error in red. The owner edits any field, adds or removes lines, changes the
 * product mapping (or creates a new product), then confirms. Edits auto-save
 * and are re-checked by the server (totals, GST maths, GSTIN, duplicate).
 *
 * mode "capture": a bill being read → Confirm books it.
 * mode "correction": a confirmed purchase reopened → Save posts reversing and
 * corrected entries (never an overwrite), with a reason.
 *
 * The page keys this component by the capture's status and update time, so
 * when the reader finishes (router.refresh) it starts again from the new draft.
 */
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { GST_STATES } from "@/lib/gst-states";
import { computeTotals, draftToPurchase, emptyLine, hasErrors, LOW_CONFIDENCE, validateDraft, type BillDraft, type DraftField, type DraftIssue, type DraftLine } from "@/lib/accounts/bill-draft";

import { accountsApi, ApiError, qty as fmtQty, rupees } from "./api";

export interface ReviewFile {
  id: string;
  contentType: string;
  name: string | null;
}

export interface ReviewListing {
  shopProductId: string;
  name: string;
  sellableUnit: string;
  hsn: string | null;
  gstRateBp: number | null;
}

interface Props {
  shopId: string;
  mode: "capture" | "correction";
  /** Capture id (capture mode) or purchase id (correction mode). */
  id: string;
  status: "QUEUED" | "PROCESSING" | "READY_FOR_REVIEW" | "CONFIRMED" | "FAILED" | "DISCARDED";
  progress: number;
  stage: string | null;
  error: string | null;
  engine: string | null;
  initialDraft: BillDraft | null;
  initialIssues: DraftIssue[];
  files: ReviewFile[];
  listings: ReviewListing[];
  shopQuery?: string;
}

const toRupeeInput = (paise: number | null) => (paise == null ? "" : (paise / 100).toFixed(2).replace(/\.00$/, ""));
const fromRupeeInput = (v: string): number | null => {
  const s = v.replace(/[₹,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const fromQtyInput = (v: string): number | null => {
  const s = v.replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

/** User-typed value: full confidence. */
const typed = <T,>(value: T): DraftField<T> => ({ value, confidence: 100 });

function confidenceClass(field: DraftField<unknown>, hasError: boolean): string {
  if (hasError) return "border-red-600 bg-red-50 ring-1 ring-red-600";
  if (field.value != null && field.value !== "" && field.confidence < LOW_CONFIDENCE) return "border-amber-500 bg-amber-50";
  return "";
}

export function BillReview(props: Props) {
  const { shopId, mode, id, files, listings, shopQuery = "" } = props;
  const router = useRouter();
  const [status, setStatus] = useState(props.status);
  const [progress, setProgress] = useState(props.progress);
  const [stage, setStage] = useState(props.stage);
  const [draft, setDraft] = useState<BillDraft | null>(props.initialDraft);
  const [issues, setIssues] = useState<DraftIssue[]>(props.initialIssues);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<"bill" | "details">("details");
  const [reason, setReason] = useState("");
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef(0);

  /* ------------------------------------------- waiting for the reader */
  useEffect(() => {
    if (mode !== "capture" || (status !== "QUEUED" && status !== "PROCESSING")) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await accountsApi<{ status: Props["status"]; progress: number; stage: string | null }>(shopId, `bills/${id}/status`);
        if (stop) return;
        setProgress(s.progress);
        setStage(s.stage);
        if (s.status !== "QUEUED" && s.status !== "PROCESSING") {
          setStatus(s.status);
          router.refresh();
          return;
        }
      } catch {
        /* slow network: try again */
      }
      if (!stop) setTimeout(tick, 2500);
    };
    const t = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [mode, status, shopId, id, router]);

  /* --------------------------------------------------------- saving */
  const localIssues = useMemo(() => (draft ? validateDraft(draft) : []), [draft]);
  // Server issues (duplicate, conversions) + local checks, without repeats.
  const allIssues = useMemo(() => {
    const seen = new Set<string>();
    return [...issues.filter((i) => i.code === "DUPLICATE" || i.code === "LINE_UNIT"), ...localIssues].filter((i) => {
      const k = `${i.code}|${i.line ?? ""}|${i.field ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [issues, localIssues]);
  const totals = useMemo(() => (draft ? computeTotals(draft) : null), [draft]);

  const save = useCallback(
    async (next: BillDraft) => {
      if (mode !== "capture") return;
      const v = ++version.current;
      setSaving("saving");
      try {
        const res = await accountsApi<{ draft: BillDraft; issues: DraftIssue[] }>(shopId, `bills/${id}`, { method: "PATCH", body: { draft: next } });
        if (v !== version.current) return; // a newer edit is on its way
        // Take the server's conversions and product names; keep what the owner is typing.
        setDraft((current) =>
          current
            ? {
                ...current,
                lines: current.lines.map((l) => {
                  const s = res.draft.lines.find((x) => x.id === l.id);
                  return s ? { ...l, match: { ...l.match, productName: s.match.productName, sellableUnit: s.match.sellableUnit, stockQtyMilli: s.match.stockQtyMilli, conversionProblem: s.match.conversionProblem, milliPerUnit: s.match.milliPerUnit } } : l;
                }),
              }
            : current,
        );
        setIssues(res.issues);
        setSaving("saved");
      } catch {
        setSaving("error");
      }
    },
    [mode, shopId, id],
  );

  const update = useCallback(
    (fn: (d: BillDraft) => BillDraft) => {
      setDraft((current) => {
        if (!current) return current;
        const next = fn(current);
        dirty.current = true;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void save(next), 1200);
        return next;
      });
    },
    [save],
  );

  const setLine = (lineId: string, patch: (l: DraftLine) => DraftLine, resetConversion = false) =>
    update((d) => ({
      ...d,
      lines: d.lines.map((l) => {
        if (l.id !== lineId) return l;
        const next = patch(l);
        return resetConversion ? { ...next, match: { ...next.match, stockQtyMilli: null, conversionProblem: null } } : next;
      }),
    }));

  /* -------------------------------------------------------- actions */
  async function confirm() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (mode === "capture") {
        const purchase = await accountsApi<{ id: string }>(shopId, `bills/${id}/confirm`, { method: "POST", body: { draft } });
        router.push(`/shop/accounts/purchases/${purchase.id}${shopQuery ? `${shopQuery}&` : "?"}confirmed=1`);
      } else {
        await accountsApi(shopId, `purchases/${id}`, { method: "PUT", body: { purchase: draftToPurchase(draft), reason: reason.trim() || null } });
        router.push(`/shop/accounts/purchases/${id}${shopQuery ? `${shopQuery}&` : "?"}corrected=1`);
      }
      router.refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not save. Try again.");
      if (e instanceof ApiError && (e.details as { issues?: DraftIssue[] } | undefined)?.issues) setIssues((e.details as { issues: DraftIssue[] }).issues);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirmDialog("Discard this bill? Nothing was added to your books.")) return;
    setBusy(true);
    try {
      await accountsApi(shopId, `bills/${id}`, { method: "DELETE" });
      router.push(`/shop/accounts/bills${shopQuery}`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not discard.");
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      await accountsApi(shopId, `bills/${id}/retry`, { method: "POST", body: {} });
      setStatus("QUEUED");
      setProgress(5);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not retry.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------- rendering */
  if (mode === "capture" && (status === "QUEUED" || status === "PROCESSING")) {
    return (
      <Card className="p-5" aria-live="polite" data-testid="bill-progress">
        <p className="mb-2 font-semibold text-ink-900">Reading your bill… {progress}%</p>
        <div className="h-3 w-full overflow-hidden rounded-full bg-cream-200">
          <div className="h-full bg-kesari-600 transition-[width] duration-500" style={{ width: `${Math.max(progress, 5)}%` }} />
        </div>
        <p className="mt-2 text-sm text-ink-600">{stage ?? "Waiting"} — you can leave this page; we will notify you when it is ready.</p>
      </Card>
    );
  }
  if (status === "CONFIRMED" && mode === "capture") return <Alert tone="success">This bill is in your books. Open it from Purchases to correct it.</Alert>;
  if (status === "DISCARDED") return <Alert tone="info">This bill was discarded.</Alert>;
  if (!draft) {
    return (
      <Card className="space-y-3 p-5">
        <Alert tone="danger" title="The bill could not be read">{props.error ?? "Unknown problem."}</Alert>
        <div className="flex gap-2">
          <Button onClick={() => void retry()} disabled={busy}>Read again</Button>
          <Button variant="secondary" onClick={() => void discard()} disabled={busy}>Discard</Button>
        </div>
      </Card>
    );
  }

  const fieldError = (field: string, line?: number) => allIssues.some((i) => i.severity === "error" && i.field === field && (line == null || i.line === line));
  const errors = allIssues.filter((i) => i.severity === "error");
  const warnings = allIssues.filter((i) => i.severity === "warn");
  const blocked = hasErrors(allIssues) || (mode === "correction" && !reason.trim());

  return (
    <div className="space-y-3" data-testid="bill-review">
      {/* Phone: switch between the bill and the details. */}
      <div className="flex gap-1.5 lg:hidden" role="tablist">
        {(["details", "bill"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={clsx("min-h-10 flex-1 rounded-xl text-sm font-semibold", view === v ? "bg-kesari-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900")}>
            {v === "details" ? "Details to check" : `Original bill (${files.length})`}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* ------------------------------------------------ original bill */}
        <section aria-label="Original bill" className={clsx("lg:sticky lg:top-2 lg:block lg:max-h-[calc(100svh-6rem)] lg:overflow-auto", view === "bill" ? "block" : "hidden")}>
          <BillViewer shopId={shopId} files={files} />
          {draft.notes.length ? (
            <ul className="mt-2 space-y-1 text-xs text-ink-700">
              {draft.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          ) : null}
          {props.engine ? <p className="mt-1 text-xs text-ink-500">Read by: {ENGINE_LABEL[props.engine] ?? props.engine}</p> : null}
        </section>

        {/* ------------------------------------------------ details */}
        <section aria-label="Bill details" className={clsx("space-y-3 lg:block", view === "details" ? "block" : "hidden")}>
          <Legend />
          <Card className="grid gap-2 p-3 sm:grid-cols-2">
            <TextInput label="Supplier name" field={draft.supplierName} error={fieldError("supplierName")} onChange={(v) => update((d) => ({ ...d, supplierName: typed(v || null) }))} testId="f-supplier" />
            <TextInput label="Supplier GSTIN" field={draft.supplierGstin} error={fieldError("supplierGstin")} onChange={(v) => update((d) => ({ ...d, supplierGstin: typed(v.toUpperCase().replace(/\s+/g, "") || null) }))} maxLength={15} testId="f-gstin" />
            <TextInput label="Invoice number" field={draft.invoiceNo} error={fieldError("invoiceNo")} onChange={(v) => update((d) => ({ ...d, invoiceNo: typed(v || null) }))} testId="f-invoice" />
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Invoice date</span>
              <input type="date" value={draft.invoiceDate.value ?? ""} onChange={(e) => update((d) => ({ ...d, invoiceDate: typed(e.target.value || null) }))} className={clsx(inputClass, confidenceClass(draft.invoiceDate, fieldError("invoiceDate")))} data-testid="f-date" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Place of supply</span>
              <select value={draft.placeOfSupply.value ?? ""} onChange={(e) => update((d) => ({ ...d, placeOfSupply: typed(e.target.value || null) }))} className={clsx(inputClass, confidenceClass(draft.placeOfSupply, fieldError("placeOfSupply")))}>
                <option value="">—</option>
                {GST_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 pt-5 text-sm">
              <input type="checkbox" checked={draft.reverseCharge} onChange={(e) => update((d) => ({ ...d, reverseCharge: e.target.checked }))} />
              Reverse charge applies
            </label>
            {draft.einvoice ? (
              <p className="text-xs text-green-800 sm:col-span-2">
                ✓ E-invoice QR: IRN {draft.einvoice.irn.slice(0, 16)}… {draft.einvoice.signatureVerified ? "(signature verified)" : ""}
              </p>
            ) : null}
          </Card>

          {/* Lines */}
          <div className="space-y-2" data-testid="bill-lines">
            {draft.lines.map((line, i) => (
              <LineEditor
                key={line.id}
                n={i + 1}
                line={line}
                listings={listings}
                errorFor={(f) => fieldError(f, i + 1)}
                onChange={(patch, reset) => setLine(line.id, patch, reset)}
                onRemove={() => update((d) => ({ ...d, lines: d.lines.filter((l) => l.id !== line.id) }))}
              />
            ))}
            <Button variant="secondary" size="sm" onClick={() => update((d) => ({ ...d, lines: [...d.lines, emptyLine(`new-${Date.now()}`)] }))} data-testid="add-line">
              + Add item
            </Button>
          </div>

          {/* Totals */}
          <Card className="p-3">
            <p className="mb-2 text-sm font-bold text-ink-900">Totals {totals?.interState ? "(other state: IGST)" : "(same state: CGST + SGST)"}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ["taxablePaise", "Taxable", totals?.taxablePaise],
                  ["cgstPaise", "CGST", totals?.cgstPaise],
                  ["sgstPaise", "SGST", totals?.sgstPaise],
                  ["igstPaise", "IGST", totals?.igstPaise],
                  ["otherChargesPaise", "Other charges", totals?.otherChargesPaise],
                  ["roundOffPaise", "Round off", totals?.roundOffPaise],
                  ["totalPaise", "Bill total", totals?.totalPaise],
                ] as const
              ).map(([key, label, computed]) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-700">{label} (bill)</span>
                  <MoneyInput field={draft.totals[key]} error={fieldError(`totals.${key}`)} onChange={(v) => update((d) => ({ ...d, totals: { ...d.totals, [key]: typed(v) } }))} testId={`t-${key}`} />
                  <span className="mt-0.5 block text-xs text-ink-600">Items: {rupees(computed ?? 0)}</span>
                </label>
              ))}
            </div>
          </Card>

          {/* Checks */}
          <div aria-live="polite" className="space-y-2" data-testid="bill-issues">
            {errors.length ? (
              <Alert tone="danger" title={`Fix before ${mode === "capture" ? "confirming" : "saving"} (${errors.length})`}>
                <ul className="list-disc pl-4">
                  {errors.map((i, k) => (
                    <li key={k}>{i.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <Alert tone="success">All checks passed: totals add up, GST maths and GSTIN are correct.</Alert>
            )}
            {warnings.length ? (
              <Alert tone="warning" title="Please check">
                <ul className="list-disc pl-4">
                  {warnings.map((i, k) => (
                    <li key={k}>{i.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {message ? <Alert tone="danger">{message}</Alert> : null}
          </div>

          {mode === "correction" ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">Why are you correcting this bill? (kept in the history)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} maxLength={300} data-testid="correction-reason" />
            </label>
          ) : null}

          <div className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center gap-2 border-t border-[var(--gk-line)] bg-[var(--gk-bg)] px-2 py-2">
            <Button size="lg" onClick={() => void confirm()} disabled={busy || blocked} data-testid="bill-confirm">
              {mode === "capture" ? "Confirm & add to stock" : "Save correction"}
            </Button>
            {mode === "capture" ? (
              <Button variant="secondary" onClick={() => void discard()} disabled={busy}>
                Discard
              </Button>
            ) : null}
            <span className="text-xs text-ink-600" aria-live="polite">
              {mode === "capture" ? (saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "error" ? "Not saved — check your connection" : "") : "A correction adds reversing entries; nothing is overwritten."}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

const ENGINE_LABEL: Record<string, string> = {
  EINVOICE_JSON: "e-invoice JSON (trusted)",
  EINVOICE_QR: "e-invoice QR (trusted header) + reader",
  EXCEL: "spreadsheet",
  AI: "AI reader",
  PDF_TEXT: "PDF text",
  OCR: "photo text recognition (OCR)",
  MANUAL: "typed by you",
};

function confirmDialog(text: string): boolean {
  return typeof window === "undefined" ? true : window.confirm(text);
}

function Legend() {
  return (
    <p className="flex flex-wrap items-center gap-3 text-xs text-ink-700">
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded border border-amber-500 bg-amber-50" /> Not sure — check
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded border border-red-600 bg-red-50" /> Needs fixing
      </span>
    </p>
  );
}

function TextInput({ label, field, error, onChange, maxLength, testId }: { label: string; field: DraftField<string | null>; error: boolean; onChange: (v: string) => void; maxLength?: number; testId?: string }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-700">
        {label}
        {field.value && field.confidence < LOW_CONFIDENCE ? <span className="rounded bg-amber-100 px-1 text-[0.65rem] font-bold text-amber-900">{field.confidence}%</span> : null}
      </span>
      <input value={field.value ?? ""} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} className={clsx(inputClass, confidenceClass(field, error))} data-testid={testId} aria-invalid={error || undefined} />
    </label>
  );
}

function MoneyInput({ field, error, onChange, testId }: { field: DraftField<number | null>; error: boolean; onChange: (v: number | null) => void; testId?: string }) {
  const [text, setText] = useState(toRupeeInput(field.value));
  const last = useRef(field.value);
  useEffect(() => {
    if (field.value !== last.current) {
      last.current = field.value;
      setText(toRupeeInput(field.value));
    }
  }, [field.value]);
  return (
    <input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = fromRupeeInput(e.target.value);
        last.current = v;
        onChange(v);
      }}
      className={clsx(inputClass, "tabular-nums", confidenceClass(field, error))}
      data-testid={testId}
      aria-invalid={error || undefined}
    />
  );
}

function QtyInput({ field, error, onChange, testId }: { field: DraftField<number | null>; error: boolean; onChange: (v: number | null) => void; testId?: string }) {
  const [text, setText] = useState(fmtQty(field.value));
  const last = useRef(field.value);
  useEffect(() => {
    if (field.value !== last.current) {
      last.current = field.value;
      setText(fmtQty(field.value));
    }
  }, [field.value]);
  return (
    <input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = fromQtyInput(e.target.value);
        last.current = v;
        onChange(v);
      }}
      className={clsx(inputClass, "tabular-nums", confidenceClass(field, error))}
      data-testid={testId}
      aria-invalid={error || undefined}
    />
  );
}

function LineEditor({ n, line, listings, errorFor, onChange, onRemove }: { n: number; line: DraftLine; listings: ReviewListing[]; errorFor: (field: string) => boolean; onChange: (patch: (l: DraftLine) => DraftLine, resetConversion?: boolean) => void; onRemove: () => void }) {
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (q ? listings.filter((l) => l.name.toLowerCase().includes(q)) : listings).slice(0, 30);
  }, [search, listings]);
  const choose = (l: ReviewListing) => {
    onChange((x) => ({ ...x, match: { ...x.match, shopProductId: l.shopProductId, productName: l.name, sellableUnit: l.sellableUnit, method: "USER", score: 1, createNew: null, milliPerUnit: null } }), true);
    setPicking(false);
  };
  const createNew = () => {
    onChange(
      (x) => ({
        ...x,
        match: {
          ...x.match,
          shopProductId: null,
          productName: null,
          method: "NEW",
          createNew: { name: x.description.value.slice(0, 160) || "New product", unit: "piece", hsn: x.hsn.value, gstRateBp: x.gstRateBp.value, mrpPaise: x.mrpPaise.value, sellingPricePaise: null },
        },
      }),
      true,
    );
    setPicking(false);
  };
  const m = line.match;
  return (
    <Card className="p-2.5" data-testid="bill-line">
      <div className="mb-2 flex items-start gap-2">
        <span className="mt-2 w-6 shrink-0 text-center text-xs font-bold text-ink-600">{n}</span>
        <div className="min-w-0 flex-1">
          <TextInput label="Item (as on the bill)" field={line.description} error={errorFor("description")} onChange={(v) => onChange((x) => ({ ...x, description: typed(v) }))} testId={`l${n}-desc`} />
        </div>
        <button type="button" onClick={onRemove} className="mt-5 min-h-10 rounded-lg px-2 text-sm text-red-700 hover:bg-red-50" aria-label={`Remove item ${n}`}>
          ✕
        </button>
      </div>

      {/* Product mapping */}
      <div className={clsx("mb-2 rounded-xl border p-2", errorFor("match") ? "border-red-600 bg-red-50" : m.method && m.method !== "USER" && m.score < 0.8 ? "border-amber-500 bg-amber-50" : "border-[var(--gk-line)] bg-cream-50")}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-ink-700">Your product:</span>
          {m.createNew ? (
            <span className="font-semibold text-violet-800">New: {m.createNew.name}</span>
          ) : m.shopProductId ? (
            <span className="font-semibold text-ink-900" data-testid={`l${n}-product`}>
              {m.productName}
              {m.method && m.method !== "USER" ? <span className="ml-1 text-xs font-normal text-ink-600">({METHOD_LABEL[m.method]}{m.method !== "SUPPLIER_MAP" && m.method !== "BARCODE" ? ` ${Math.round(m.score * 100)}%` : ""})</span> : null}
            </span>
          ) : (
            <span className="font-semibold text-red-700">Not matched</span>
          )}
          <Button size="sm" variant="secondary" onClick={() => setPicking((p) => !p)} data-testid={`l${n}-change`}>
            {m.shopProductId || m.createNew ? "Change" : "Choose"}
          </Button>
        </div>
        {!m.shopProductId && !m.createNew && m.suggestions.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.suggestions.map((s) => {
              const l = listings.find((x) => x.shopProductId === s.shopProductId);
              return l ? (
                <button key={s.shopProductId} type="button" onClick={() => choose(l)} className="min-h-9 rounded-lg border border-kesari-300 bg-white px-2 text-xs hover:bg-kesari-50">
                  {s.name} · {Math.round(s.score * 100)}%
                </button>
              ) : null;
            })}
          </div>
        ) : null}
        {picking ? (
          <div className="mt-2 space-y-1">
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your products" className={inputClass} aria-label="Search your products" />
            <ul className="max-h-48 overflow-auto rounded-lg border border-cream-200 bg-white">
              {results.map((l) => (
                <li key={l.shopProductId}>
                  <button type="button" onClick={() => choose(l)} className="flex min-h-10 w-full items-center justify-between gap-2 px-2 text-left text-sm hover:bg-kesari-50">
                    <span className="truncate">{l.name}</span>
                    <span className="shrink-0 text-xs text-ink-600">{l.sellableUnit}</span>
                  </button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" onClick={createNew} data-testid={`l${n}-new`}>
              + Create new product “{line.description.value.slice(0, 40)}”
            </Button>
          </div>
        ) : null}
        {m.createNew ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="col-span-2 block">
              <span className="mb-1 block text-xs text-ink-700">New product name</span>
              <input value={m.createNew.name} onChange={(e) => onChange((x) => ({ ...x, match: { ...x.match, createNew: { ...x.match.createNew!, name: e.target.value } } }))} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-700">Sold by</span>
              <select value={m.createNew.unit} onChange={(e) => onChange((x) => ({ ...x, match: { ...x.match, createNew: { ...x.match.createNew!, unit: e.target.value } } }))} className={inputClass}>
                {["piece", "pack", "kg", "g", "L", "ml"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <p className="self-end text-xs text-ink-600">It is added to your catalogue (not on sale online until you set a price).</p>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">Qty</span>
          <QtyInput field={line.qtyMilli} error={errorFor("qtyMilli")} onChange={(v) => onChange((x) => ({ ...x, qtyMilli: typed(v) }), true)} testId={`l${n}-qty`} />
        </label>
        <TextInput label="Unit" field={line.unit} error={errorFor("unit")} onChange={(v) => onChange((x) => ({ ...x, unit: typed(v || null) }), true)} testId={`l${n}-unit`} />
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">Rate ₹ (before GST)</span>
          <MoneyInput field={line.ratePaise} error={errorFor("ratePaise")} onChange={(v) => onChange((x) => ({ ...x, ratePaise: typed(v) }))} testId={`l${n}-rate`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">Discount ₹</span>
          <MoneyInput field={line.discountPaise} error={false} onChange={(v) => onChange((x) => ({ ...x, discountPaise: typed(v) }))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">GST %</span>
          <select
            value={line.gstRateBp.value == null ? "" : String(line.gstRateBp.value)}
            onChange={(e) => onChange((x) => ({ ...x, gstRateBp: typed(e.target.value === "" ? null : Number(e.target.value)) }))}
            className={clsx(inputClass, confidenceClass(line.gstRateBp, errorFor("gstRateBp")))}
            data-testid={`l${n}-gst`}
          >
            <option value="">—</option>
            {[0, 25, 300, 500, 1200, 1800, 2800, 4000, ...(line.gstRateBp.value != null && ![0, 25, 300, 500, 1200, 1800, 2800, 4000].includes(line.gstRateBp.value) ? [line.gstRateBp.value] : [])].map((bp) => (
              <option key={bp} value={bp}>
                {bp / 100}%
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">Taxable ₹ (bill)</span>
          <MoneyInput field={line.taxablePaise} error={errorFor("taxablePaise")} onChange={(v) => onChange((x) => ({ ...x, taxablePaise: typed(v) }))} testId={`l${n}-taxable`} />
        </label>
        <TextInput label="HSN" field={line.hsn} error={false} onChange={(v) => onChange((x) => ({ ...x, hsn: typed(v.replace(/\D/g, "").slice(0, 8) || null) }))} />
        <TextInput label="Batch" field={line.batchNo} error={false} onChange={(v) => onChange((x) => ({ ...x, batchNo: typed(v || null) }))} />
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">Expiry</span>
          <input type="date" value={line.expiryDate.value ?? ""} onChange={(e) => onChange((x) => ({ ...x, expiryDate: typed(e.target.value || null) }))} className={clsx(inputClass, confidenceClass(line.expiryDate, false))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-700">MRP ₹</span>
          <MoneyInput field={line.mrpPaise} error={false} onChange={(v) => onChange((x) => ({ ...x, mrpPaise: typed(v) }))} />
        </label>
      </div>

      {/* Stock effect */}
      {m.shopProductId && !m.createNew ? (
        <div className="mt-2 text-xs">
          {m.conversionProblem ? (
            <div className="flex flex-wrap items-center gap-2 text-red-800">
              <span>{m.conversionProblem}</span>
              <label className="flex items-center gap-1">
                1 {line.unit.value ?? "unit"} =
                <input
                  inputMode="decimal"
                  className={clsx(inputClass, "w-20")}
                  aria-label="Sellable units per billed unit"
                  onChange={(e) => {
                    const v = fromQtyInput(e.target.value);
                    onChange((x) => ({ ...x, match: { ...x.match, milliPerUnit: v && v > 0 ? v : null } }), true);
                  }}
                />
                × {m.sellableUnit}
              </label>
            </div>
          ) : m.stockQtyMilli != null ? (
            <span className="text-green-800" data-testid={`l${n}-stock`}>
              Adds {fmtQty(m.stockQtyMilli)} × {m.sellableUnit} to stock
            </span>
          ) : (
            <span className="text-ink-600">Stock quantity is worked out when saved…</span>
          )}
        </div>
      ) : null}
    </Card>
  );
}

const METHOD_LABEL: Record<string, string> = {
  BARCODE: "barcode",
  SUPPLIER_MAP: "remembered for this supplier",
  HSN_NAME: "HSN + name",
  NAME: "name",
  NEW: "new",
  USER: "chosen",
};

function BillViewer({ shopId, files }: { shopId: string; files: ReviewFile[] }) {
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(false);
  if (files.length === 0) return <Card className="p-4 text-sm text-ink-600">No file — typed by hand.</Card>;
  const f = files[Math.min(page, files.length - 1)];
  const url = `/api/shops/${shopId}/accounts/files/${f.id}`;
  return (
    <Card className="overflow-hidden p-2" data-testid="bill-viewer">
      {files.length > 1 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {files.map((x, i) => (
            <button key={x.id} type="button" onClick={() => setPage(i)} className={clsx("min-h-9 min-w-9 rounded-lg text-sm font-semibold", i === page ? "bg-kesari-700 text-white" : "border border-cream-200 bg-white")}>
              {i + 1}
            </button>
          ))}
        </div>
      ) : null}
      {f.contentType.startsWith("image/") ? (
        <div className={clsx("overflow-auto rounded-lg bg-cream-100", zoom ? "max-h-[75svh]" : "")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- private, access-checked file, not an optimisable public image */}
          <img src={url} alt={`Bill page ${page + 1}`} onClick={() => setZoom((z) => !z)} className={clsx("cursor-zoom-in", zoom ? "max-w-none" : "h-auto w-full")} style={zoom ? { width: "200%" } : undefined} />
        </div>
      ) : f.contentType === "application/pdf" ? (
        <>
          <iframe src={url} title={`Bill page ${page + 1}`} className="h-[70svh] w-full rounded-lg border-0 bg-white" />
          {/* Phone browsers and the app's WebView may not show a PDF inside the page. */}
          <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-10 items-center text-sm font-semibold text-kesari-800 underline">
            Open the PDF
          </a>
        </>
      ) : (
        <div className="p-4 text-sm text-ink-700">
          {f.name ?? "Data file"} — {f.contentType.includes("json") ? "e-invoice data" : "spreadsheet"}.{" "}
          <a href={url} className="font-semibold text-kesari-800 underline">
            Download
          </a>
        </div>
      )}
      {f.contentType.startsWith("image/") ? <p className="mt-1 text-xs text-ink-500">Tap the picture to zoom.</p> : null}
    </Card>
  );
}
