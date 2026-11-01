"use client";

/**
 * Billing v2 (docs/billing §7, §8): the sync screen's controls. Export and
 * import go to the accounts API; the server validates, records and decides.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import type { Lang } from "@/lib/board/i18n";

interface Tool {
  system: string;
  label: string;
  file: "XLSX" | "CSV";
  records: number;
  failed: number;
  conflicts: number;
  lastExport: string | null;
  lastImport: string | null;
}
interface Conflict {
  id: string;
  system: string;
  entityType: string;
  externalKey: string;
  local: Record<string, unknown>;
  incoming: Record<string, unknown>;
}
interface Fix {
  entity: string;
  key: string;
  problem: string;
}

const UQCS = ["NOS", "PCS", "PAC", "KGS", "GMS", "LTR", "MLT", "DOZ", "BOX", "BTL", "BAG", "BDL", "CAN", "CTN", "MTR", "SET", "PRS", "TBS", "TIN", "TUB", "ROL", "UNT", "QTL", "TON", "OTH"];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "never");

export function SyncPanel({ shopId, lang, defaultFrom, defaultTo, tools, conflicts, unmappedUnits }: { shopId: string; lang: Lang; defaultFrom: string; defaultTo: string; tools: Tool[]; conflicts: Conflict[]; unmappedUnits: string[] }) {
  const router = useRouter();
  const api = `/api/shops/${shopId}/accounts/sync`;
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [fixes, setFixes] = useState<Fix[] | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, string>>({});

  async function exportTool(tool: string) {
    setBusy(tool);
    setMessage(null);
    setFixes(null);
    try {
      const res = await fetch(`${api}/export?tool=${tool}&from=${from}&to=${to}`);
      if (res.status === 409) {
        const body = await res.json();
        setFixes(body.error.fixes);
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Export failed.");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `gokesari-${tool}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      router.refresh();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Export failed." });
    } finally {
      setBusy(null);
    }
  }

  async function importTool(tool: string, file: File) {
    setBusy(`in-${tool}`);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${api}/import?tool=${tool}`, { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Import failed.");
      const s = body.data ?? body;
      setMessage({
        tone: "success",
        text: `Imported: ${s.parties.created} new and ${s.parties.updated} updated parties, ${s.items.updated} items, ${s.vouchers.created} vouchers. ${s.vouchers.skipped.length} skipped, ${s.items.notFound.length} items not on GoKesari, ${s.conflicts} conflict(s) to decide.`,
      });
      router.refresh();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Import failed." });
    } finally {
      setBusy(null);
    }
  }

  async function send(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setMessage({ tone: "danger", text: (await res.json().catch(() => null))?.error?.message ?? "Not saved." });
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-semibold text-ink-700" htmlFor="sync-from">
          From
        </label>
        <input id="sync-from" type="date" className={`${inputClass} w-40`} value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className="text-sm font-semibold text-ink-700" htmlFor="sync-to">
          to (not included)
        </label>
        <input id="sync-to" type="date" className={`${inputClass} w-40`} value={to} onChange={(e) => setTo(e.target.value)} />
        <a href={`${api}/templates`} className="ml-auto inline-flex min-h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-kesari-50">
          Template pack (all software)
        </a>
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {fixes?.length ? (
        <Alert tone="danger" title={`Fix ${fixes.length} item(s) before exporting`}>
          <ul className="list-disc pl-5" data-testid="sync-fixes">
            {fixes.slice(0, 20).map((f, i) => (
              <li key={i}>
                {f.key}: {f.problem}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="sync-tools">
        {tools.map((t) => (
          <li key={t.system}>
            <Card className="flex h-full flex-col gap-1.5 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="font-bold text-ink-900">{t.label}</p>
                {t.conflicts ? <Badge tone="danger">{t.conflicts} to decide</Badge> : null}
              </div>
              <p className="text-xs text-ink-600">
                Sent {when(t.lastExport)} · received {when(t.lastImport)} · {t.records} record(s)
                {t.failed ? ` · ${t.failed} failed` : ""}
              </p>
              <div className="mt-auto flex flex-wrap gap-1.5">
                <Button size="sm" disabled={busy === t.system} onClick={() => exportTool(t.system)}>
                  {busy === t.system ? "Preparing…" : "Send to software"}
                </Button>
                <label className="inline-flex min-h-9 cursor-pointer items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-kesari-50">
                  {busy === `in-${t.system}` ? "Importing…" : "Bring in a file"}
                  <input
                    type="file"
                    className="sr-only"
                    accept=".xlsx,.csv,.xml,.json,.zip"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void importTool(t.system, file);
                      e.target.value = "";
                    }}
                  />
                </label>
                <a className="inline-flex min-h-9 items-center px-1 text-sm text-kesari-800 underline" href={`/shop/accounts/sync/help/${t.system.toLowerCase()}?lang=${lang}`}>
                  Help
                </a>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {unmappedUnits.length ? (
        <Card className="p-3" data-testid="sync-units">
          <p className="mb-2 font-bold text-ink-900">Units without a GST unit code (UQC)</p>
          <div className="flex flex-wrap gap-2">
            {unmappedUnits.map((u) => (
              <span key={u} className="inline-flex items-center gap-1">
                <span className="text-sm">{u}</span>
                <select aria-label={`UQC for ${u}`} className={`${inputClass} h-9 w-24`} value={units[u] ?? ""} onChange={(e) => setUnits({ ...units, [u]: e.target.value })}>
                  <option value="">UQC…</option>
                  {UQCS.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" disabled={!units[u]} onClick={() => send(`${api}/units`, "PUT", { unit: u, uqc: units[u] })}>
                  Save
                </Button>
              </span>
            ))}
          </div>
        </Card>
      ) : null}
      {conflicts.length ? (
        <Card className="p-3" data-testid="sync-conflicts">
          <p className="mb-2 font-bold text-ink-900">Changed on both sides — choose which to keep</p>
          <ul className="grid gap-2">
            {conflicts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--gk-line)] pb-2 last:border-b-0">
                <span className="min-w-0 flex-1 text-sm">
                  <b>{c.entityType.toLowerCase()}</b> {c.externalKey} ({c.system.toLowerCase()})
                </span>
                <Button size="sm" variant="secondary" onClick={() => send(`${api}/conflicts/${c.id}`, "POST", { choice: "KEEP_LOCAL" })}>
                  Keep GoKesari&apos;s
                </Button>
                {c.entityType === "PARTY" ? (
                  <Button size="sm" variant="secondary" onClick={() => send(`${api}/conflicts/${c.id}`, "POST", { choice: "TAKE_INCOMING" })}>
                    Take {c.system.toLowerCase()}&apos;s
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
