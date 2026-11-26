"use client";

/**
 * Admin → Seller agreements (docs/seller-agreements-2026-11).
 * Tabs: Templates (versions by document and language; open one to edit a draft, see the publishing checks,
 * preview with the sample shop in each language, confirm legal review, publish, retire; upload a new version),
 * Acceptances (filters, signed PDFs, CSV, e-mail log, resend), Pending shops, Settings (e-seal).
 */
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

type Lang = "en" | "mr" | "hi";
type Template = {
  id: string;
  docType: "SELLER_SLA" | "MEDICAL_ONBOARDING";
  language: Lang;
  version: string;
  effectiveDate: string;
  title: string;
  status: "DRAFT" | "PUBLISHED" | "RETIRED";
  reviewStatus: "NOT_REQUIRED" | "PENDING_LEGAL_REVIEW" | "REVIEWED";
  reviewNotes: { key: string; text: string; confirmedAt?: string | null }[];
  appliesToShopTypes: string[];
  sourceValues: Record<string, unknown>;
  changeSummary: string | null;
  requiresResign: boolean;
  publishedAt: string | null;
  templateSha256: string;
  templateBody?: string;
};
type Overview = {
  canEdit: boolean;
  flagEnabled: boolean;
  templates: Template[];
  pending: { pending: number; overdue: number; awaitingOwnerLink: number; shops: { shopId: string; name: string; reason: string; graceUntilIst: string; overdue: boolean }[] };
  settings: Record<string, unknown> & { eSealAssetId: string; platformSignatoryName: string; platformSignatoryDesignation: string; stampDutyBorneBy: string; graceDays: number; ccEmails: string[] };
};
type Acceptance = {
  id: string;
  signingRequestId: string;
  shopName: string | null;
  sellerId: string | null;
  docTitle: string;
  version: string;
  acceptedAtIst: string;
  signerName: string;
  signerDesignation: string;
  appPlatform: string;
  ipAddress: string | null;
  registeredByRole: string;
  verifyCode: string;
  languageViewed: string;
  files: { id: string; language: Lang; kind: "SIGNED" | "CERTIFIED"; sha256: string }[];
};

const LANG: Record<Lang, string> = { en: "English", mr: "मराठी", hi: "हिंदी" };
const DOC: Record<string, string> = { SELLER_SLA: "Seller SLA", MEDICAL_ONBOARDING: "Medical Onboarding Agreement" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: unknown } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? "Request failed.");
  return (body?.data ?? body) as T;
}

function TemplateEditor({ id, canEdit, onChanged }: { id: string; canEdit: boolean; onChanged: () => void }) {
  const [data, setData] = useState<{ template: Template & { templateBody: string }; checks: { blocking: string[]; warnings: string[] } | null; tokens: { fields: string[]; partials: string[] } | null } | null>(null);
  const [body, setBody] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [applies, setApplies] = useState("");
  const [sourceJson, setSourceJson] = useState("{}");
  const [summary, setSummary] = useState("");
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await api<NonNullable<typeof data>>(`/api/admin/agreements/${id}`);
    setData(d);
    setBody(d.template.templateBody);
    setEffectiveDate(d.template.effectiveDate);
    setApplies(d.template.appliesToShopTypes.join(", "));
    setSourceJson(JSON.stringify(d.template.sourceValues, null, 2));
    setSummary(d.template.changeSummary ?? "");
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once; setState runs after the fetch
    void load().catch((e: Error) => setMsg({ tone: "danger", text: e.message }));
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "success", text: label });
      await load();
      onChanged();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }
  async function showPreview() {
    const r = await fetch(`/api/admin/agreements/${id}/preview`);
    setPreview(await r.text());
  }

  if (!data) return <p className="text-sm text-ink-500">Loading…</p>;
  const t = data.template;
  const draft = t.status === "DRAFT";
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{DOC[t.docType]} v{t.version} – {LANG[t.language]}</h3>
        <Badge>{t.status}</Badge>
        {t.reviewStatus === "PENDING_LEGAL_REVIEW" ? <Badge tone="warning">Pending legal review</Badge> : null}
        {t.reviewStatus === "REVIEWED" ? <Badge tone="success">Legal review done</Badge> : null}
      </div>
      <p className="break-all text-xs text-ink-500">Template SHA-256 {t.templateSha256}</p>

      {data.checks ? (
        <div className="space-y-2">
          {data.checks.blocking.length ? (
            <Alert tone="danger" title="Blocking – fix before publishing">
              <ul className="list-disc pl-5">{data.checks.blocking.map((b) => <li key={b}>{b}</li>)}</ul>
            </Alert>
          ) : (
            <Alert tone="success">No blocking problems.</Alert>
          )}
          {data.checks.warnings.length ? (
            <Alert tone="warning" title="Warnings – read and acknowledge">
              <ul className="list-disc pl-5">{data.checks.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {canEdit && draft ? (
        <div className="space-y-2">
          {t.reviewNotes.filter((n) => !n.confirmedAt).map((n) => (
            <div key={n.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">{n.text}</span>
              <Button size="sm" variant="secondary" onClick={() => void run("Review confirmed.", () => api(`/api/admin/agreements/${id}`, { method: "POST", body: JSON.stringify({ action: "review", what: n.key }) }))}>
                A lawyer reviewed this
              </Button>
            </div>
          ))}
          {t.reviewStatus === "PENDING_LEGAL_REVIEW" ? (
            <Button size="sm" variant="secondary" onClick={() => void run("Translation marked reviewed.", () => api(`/api/admin/agreements/${id}`, { method: "POST", body: JSON.stringify({ action: "review", what: "translation" }) }))}>
              Mark translation reviewed by a lawyer
            </Button>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Effective date (YYYY-MM-DD)">
              <input className={inputClass} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </Field>
            <Field label="Applies to shop types (keys, comma-separated; empty = all)">
              <input className={inputClass} value={applies} onChange={(e) => setApplies(e.target.value)} />
            </Field>
          </div>
          {t.language === "en" ? (
            <Field label="Figures the document states (for the publishing checks): commissionPct, settlementDays, registrationFeeRupees, …">
              <textarea className={`${inputClass} font-mono text-xs`} rows={5} value={sourceJson} onChange={(e) => setSourceJson(e.target.value)} />
            </Field>
          ) : null}
          <Field label="What changed (shown in the change notice)">
            <input className={inputClass} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <Field label={`Template HTML (merge fields: ${data.tokens?.fields.length ?? 0}, blocks: ${data.tokens?.partials.join(", ") ?? ""})`}>
            <textarea className={`${inputClass} font-mono text-xs`} rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <Button
            variant="secondary"
            onClick={() =>
              void run("Draft saved.", async () => {
                let sourceValues: unknown;
                try {
                  sourceValues = JSON.parse(sourceJson || "{}");
                } catch {
                  throw new Error("The stated figures must be valid JSON.");
                }
                await api(`/api/admin/agreements/${id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    effectiveDate,
                    templateBody: body,
                    appliesToShopTypes: applies.split(",").map((s) => s.trim()).filter(Boolean),
                    ...(t.language === "en" ? { sourceValues } : {}),
                    changeSummary: summary || null,
                  }),
                });
              })
            }
          >
            Save draft
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void showPreview()}>Preview with sample shop</Button>
        <a className="text-sm font-medium text-kesari-700 underline" href={`/api/admin/agreements/${id}/preview?format=pdf`}>Sample PDF</a>
      </div>
      {preview ? <iframe title="Preview" sandbox="" srcDoc={preview.split("https://legal-assets.gokesari.invalid").join("/api/agreements/assets")} className="h-[60vh] w-full rounded border border-cream-200 bg-white" /> : null}

      {canEdit && draft ? (
        <div className="space-y-2 border-t border-cream-200 pt-3">
          {data.checks?.warnings.length ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
              <span>I have read the warnings above.</span>
            </label>
          ) : null}
          <Button
            disabled={Boolean(data.checks?.blocking.length) || (Boolean(data.checks?.warnings.length) && !ack)}
            onClick={() => void run("Published.", () => api(`/api/admin/agreements/${id}`, { method: "POST", body: JSON.stringify({ action: "publish", acknowledgeWarnings: ack }) }))}
          >
            Publish
          </Button>
        </div>
      ) : null}
      {canEdit && t.status !== "RETIRED" ? (
        <Button size="sm" variant="danger" onClick={() => confirm("Retire this version? Owners are no longer asked to sign it.") && void run("Retired.", () => api(`/api/admin/agreements/${id}`, { method: "POST", body: JSON.stringify({ action: "retire" }) }))}>
          Retire
        </Button>
      ) : null}
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </Card>
  );
}

function UploadVersion({ onDone }: { onDone: () => void }) {
  const [docType, setDocType] = useState("SELLER_SLA");
  const [language, setLanguage] = useState<Lang>("en");
  const [version, setVersion] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  async function upload() {
    setMsg(null);
    try {
      if (!file) throw new Error("Choose the template HTML file.");
      await api("/api/admin/agreements", { method: "POST", body: JSON.stringify({ docType, language, version, effectiveDate, templateBody: await file.text() }) });
      setMsg({ tone: "success", text: "Uploaded as a draft. Open it below to check and publish." });
      onDone();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  }
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Upload a new version</h3>
      <p className="text-xs text-ink-600">An HTML template with merge fields (see docs/seller-agreements-2026-11). English first; Marathi / Hindi follow the English version and start as &quot;Pending legal review&quot;.</p>
      <div className="grid gap-2 sm:grid-cols-5">
        <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="SELLER_SLA">Seller SLA</option>
          <option value="MEDICAL_ONBOARDING">Medical Onboarding</option>
        </select>
        <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
          {(Object.keys(LANG) as Lang[]).map((l) => <option key={l} value={l}>{LANG[l]}</option>)}
        </select>
        <input className={inputClass} placeholder="Version e.g. 1.1" value={version} onChange={(e) => setVersion(e.target.value)} />
        <input className={inputClass} placeholder="Effective YYYY-MM-DD" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        <input type="file" accept=".html,text/html" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <Button size="sm" onClick={() => void upload()}>Upload</Button>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </Card>
  );
}

function Acceptances() {
  const [filters, setFilters] = useState({ shop: "", docType: "", version: "", from: "", to: "" });
  const [rows, setRows] = useState<Acceptance[]>([]);
  const [total, setTotal] = useState(0);
  const [log, setLog] = useState<{ requestId: string; emails: Record<string, unknown>[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const query = () => new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
  const load = useCallback(async () => {
    const r = await api<{ rows: Acceptance[]; total: number }>(`/api/admin/agreements/acceptances?${query()}`);
    setRows(r.rows);
    setTotal(r.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads on filter change; setState runs after the fetch
    void load().catch((e: Error) => setMsg(e.message));
  }, [load]);
  return (
    <div className="space-y-3">
      <Card className="grid gap-2 sm:grid-cols-6">
        <input className={inputClass} placeholder="Shop, Seller ID or code" value={filters.shop} onChange={(e) => setFilters({ ...filters, shop: e.target.value })} />
        <select className={inputClass} value={filters.docType} onChange={(e) => setFilters({ ...filters, docType: e.target.value })}>
          <option value="">All documents</option>
          <option value="SELLER_SLA">Seller SLA</option>
          <option value="MEDICAL_ONBOARDING">Medical Onboarding</option>
        </select>
        <input className={inputClass} placeholder="Version" value={filters.version} onChange={(e) => setFilters({ ...filters, version: e.target.value })} />
        <input className={inputClass} type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From (IST)" />
        <input className={inputClass} type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To (IST)" />
        <a className="self-center text-sm font-medium text-kesari-700 underline" href={`/api/admin/agreements/acceptances?${query()}&format=csv`}>Export CSV</a>
      </Card>
      <p className="text-sm text-ink-600">{total} acceptance(s)</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink-600">
              <th className="p-2">Accepted (IST)</th><th className="p-2">Shop</th><th className="p-2">Document</th><th className="p-2">Signer</th><th className="p-2">Platform / IP</th><th className="p-2">By</th><th className="p-2">Signed PDFs</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-cream-200 align-top">
                <td className="p-2 whitespace-nowrap">{r.acceptedAtIst}</td>
                <td className="p-2">{r.shopName}<div className="text-xs text-ink-500">{r.sellerId}</div></td>
                <td className="p-2">{r.docTitle} v{r.version}<div className="text-xs text-ink-500">{r.verifyCode} · viewed {r.languageViewed}</div></td>
                <td className="p-2">{r.signerName}<div className="text-xs text-ink-500">{r.signerDesignation}</div></td>
                <td className="p-2">{r.appPlatform}<div className="text-xs text-ink-500">{r.ipAddress}</div></td>
                <td className="p-2">{r.registeredByRole}</td>
                <td className="p-2">
                  {r.files.filter((f) => f.kind === "CERTIFIED").map((f) => (
                    <a key={f.id} className="mr-2 text-kesari-700 underline" href={`/api/agreements/files/${f.id}?inline=1`} target="_blank" rel="noopener">{LANG[f.language]}</a>
                  ))}
                </td>
                <td className="p-2 whitespace-nowrap">
                  <Button size="sm" variant="secondary" onClick={() => void api(`/api/admin/agreements/acceptances`, { method: "POST", body: JSON.stringify({ action: "resend", signingRequestId: r.signingRequestId }) }).then(() => setMsg(`Signed copy queued again for ${r.shopName}.`)).catch((e: Error) => setMsg(e.message))}>
                    Resend signed copy
                  </Button>
                  <button type="button" className="ml-2 text-xs underline" onClick={() => void api<{ emails: Record<string, unknown>[] }>(`/api/admin/agreements/acceptances?emails=${r.signingRequestId}`).then((d) => setLog({ requestId: r.signingRequestId, emails: d.emails }))}>
                    E-mail log
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {log ? (
        <Card>
          <h3 className="mb-2 font-semibold">E-mail log</h3>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(log.emails, null, 2)}</pre>
        </Card>
      ) : null}
      {msg ? <Alert tone="info">{msg}</Alert> : null}
    </div>
  );
}

export function AdminAgreements() {
  const [tab, setTab] = useState<"templates" | "acceptances" | "pending" | "settings">("templates");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sealMsg, setSealMsg] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>("/api/admin/agreements").then(setOverview).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
    const t = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the tab named in the URL, read once on mount
    if (t === "acceptances" || t === "pending" || t === "settings") setTab(t);
  }, [load]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!overview) return <p className="text-sm text-ink-500">Loading…</p>;
  const groups = new Map<string, Template[]>();
  for (const t of overview.templates) groups.set(`${t.docType}|${t.version}`, [...(groups.get(`${t.docType}|${t.version}`) ?? []), t]);

  return (
    <div className="space-y-4">
      {!overview.flagEnabled ? <Alert tone="info">The feature flag seller_agreements_enabled is off: owners are not asked to sign yet. Publish the documents first, then switch it on (Admin → Feature flags).</Alert> : null}
      <div className="flex flex-wrap gap-2" role="tablist">
        {(["templates", "acceptances", "pending", "settings"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${tab === k ? "border-kesari-600 bg-kesari-50" : "border-cream-200"}`}>
            {k === "pending" ? `Pending shops (${overview.pending.pending})` : k}
          </button>
        ))}
      </div>

      {tab === "templates" ? (
        <div className="space-y-3">
          {[...groups.entries()].map(([key, rows]) => (
            <Card key={key} className="space-y-2">
              <h2 className="font-semibold">{DOC[rows[0].docType]} – version {rows[0].version} <span className="font-normal text-ink-500">effective {rows[0].effectiveDate}</span></h2>
              <div className="flex flex-wrap gap-2">
                {(["en", "mr", "hi"] as Lang[]).map((l) => {
                  const row = rows.find((r) => r.language === l);
                  if (!row) return <span key={l} className="rounded border border-dashed border-cream-200 px-2 py-1 text-xs text-ink-500">{LANG[l]}: not uploaded</span>;
                  return (
                    <button key={l} type="button" onClick={() => setOpen(open === row.id ? null : row.id)} className={`rounded border px-2 py-1 text-xs ${open === row.id ? "border-kesari-600" : "border-cream-200"}`}>
                      {LANG[l]}: {row.status}{row.reviewStatus === "PENDING_LEGAL_REVIEW" ? " · pending legal review" : ""}
                    </button>
                  );
                })}
              </div>
              {rows.some((r) => r.id === open) && open ? <TemplateEditor id={open} canEdit={overview.canEdit} onChanged={() => void load()} /> : null}
            </Card>
          ))}
          {overview.canEdit ? <UploadVersion onDone={() => void load()} /> : null}
        </div>
      ) : null}

      {tab === "acceptances" ? <Acceptances /> : null}

      {tab === "pending" ? (
        <Card className="space-y-2">
          <p className="text-sm">
            <strong>{overview.pending.pending}</strong> shop(s) must sign · <strong>{overview.pending.overdue}</strong> past the grace period (no new orders) · <strong>{overview.pending.awaitingOwnerLink}</strong> waiting for the owner&apos;s link
          </p>
          <ul className="divide-y divide-cream-200 text-sm">
            {overview.pending.shops.map((s) => (
              <li key={s.shopId} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>{s.name} <span className="text-ink-500">({s.reason.toLowerCase().replace(/_/g, " ")})</span></span>
                <span className={s.overdue ? "text-red-700" : "text-ink-600"}>{s.overdue ? "Overdue since " : "Grace until "}{s.graceUntilIst}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {tab === "settings" ? (
        <Card className="space-y-3 text-sm">
          <p>Platform signatory: <strong>{overview.settings.platformSignatoryName}</strong>, {overview.settings.platformSignatoryDesignation}</p>
          <p>Stamp duty borne by (medical agreement, lawyer review pending): <strong>{overview.settings.stampDutyBorneBy || "not set"}</strong></p>
          <p>Grace period: {overview.settings.graceDays} days · CC: {overview.settings.ccEmails.join(", ")}</p>
          <p className="text-xs text-ink-600">Change these in Admin → Settings → rule &quot;sellerAgreements&quot;.</p>
          <div className="space-y-1">
            <p className="font-medium">Company e-seal</p>
            {overview.settings.eSealAssetId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/admin/agreements/settings?v=${overview.settings.eSealAssetId}`} alt="Company e-seal" className="h-24 rounded border border-cream-200 bg-white p-1" />
            ) : (
              <p className="text-ink-600">No e-seal uploaded.</p>
            )}
            {overview.canEdit ? (
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const form = new FormData();
                  form.set("file", f);
                  void api("/api/admin/agreements/settings", { method: "POST", body: form })
                    .then(() => {
                      setSealMsg("E-seal saved: it appears on signed copies from now on.");
                      void load();
                    })
                    .catch((err: Error) => setSealMsg(err.message));
                }}
              />
            ) : null}
            {sealMsg ? <Alert tone="info">{sealMsg}</Alert> : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
