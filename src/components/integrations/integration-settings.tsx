"use client";

/**
 * Module 2: Shop settings → Integrations. Choose the accounting / inventory
 * software, connect it, see whether it is working, and fix it in words an
 * owner understands. Secrets are write-only: the screen only knows whether
 * one is saved.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface ProviderInfo {
  provider: string;
  label: string;
  description: string;
  transport: "API" | "CONNECTOR" | "FILE";
  secretFields: string[];
  oauth: boolean;
  presetConfirmed: boolean | null;
}

export interface IntegrationInfo {
  id: string;
  provider: string;
  label: string;
  transport: "API" | "CONNECTOR" | "FILE";
  status: "ACTIVE" | "PAUSED" | "ERROR" | "DISCONNECTED";
  config: Record<string, unknown>;
  hasCredentials: boolean;
  webhookConfigured: boolean;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: { code: string; message: string; fix: string; at: string | null } | null;
  connectorSeenAt: string | null;
  connectorOnline: boolean | null;
  jobs: { waiting: number; retrying: number; failed: number };
  items: { matched: number; suggested: number; unmatched: number; ignored: number; withIssue: number };
}

export interface TokenInfo {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastConnectorVersion: string | null;
  revokedAt: string | null;
}

interface Props {
  shopId: string;
  providers: ProviderInfo[];
  integration: IntegrationInfo | null;
  tokens: TokenInfo[];
  ready: { encryption: boolean; zoho: boolean };
  canManage: boolean;
  zohoOutcome: { outcome: string; reason: string | null } | null;
}

type FieldDef = { key: string; label: string; hint?: string; type?: "text" | "number" | "checkbox" | "select"; options?: [string, string][]; required?: boolean; placeholder?: string };

const PROVIDER_FIELDS: Record<string, FieldDef[]> = {
  TALLY: [
    { key: "company", label: "Company name in Tally", hint: "Exactly as shown on Gateway of Tally.", required: true },
    { key: "salesVoucherType", label: "Sales voucher type", placeholder: "Sales" },
    { key: "creditNoteVoucherType", label: "Credit note voucher type", placeholder: "Credit Note" },
    { key: "partyLedger", label: "Customer ledger (Sundry Debtors)", placeholder: "GoKesari Online Customers" },
    { key: "salesLedger", label: "Sales ledger", placeholder: "Sales" },
    { key: "cgstLedger", label: "CGST ledger", placeholder: "CGST" },
    { key: "sgstLedger", label: "SGST ledger", placeholder: "SGST" },
    { key: "igstLedger", label: "IGST ledger", placeholder: "IGST" },
    { key: "roundOffLedger", label: "Round-off ledger", placeholder: "Round Off" },
    {
      key: "unmappedItems",
      label: "A product sold online that is not matched to a Tally item",
      type: "select",
      options: [
        ["FAIL", "Stop and show it on the error screen (recommended)"],
        ["ACCOUNTING_ONLY", "Post the invoice without stock for that line"],
      ],
    },
  ],
  ODOO: [
    { key: "url", label: "Odoo address", placeholder: "https://yourshop.odoo.com", required: true },
    { key: "database", label: "Database name", required: true },
    { key: "customerName", label: "Customer for online orders", placeholder: "GoKesari Online Customers" },
    { key: "stockLocationId", label: "Stock location id (optional)", type: "number", hint: "Leave empty to use WH/Stock." },
    { key: "adjustStock", label: "Reduce Odoo stock with each invoice", type: "checkbox" },
  ],
  ZOHO_BOOKS: [{ key: "customerName", label: "Customer for online orders", placeholder: "GoKesari Online Customers" }],
  MYBILLBOOK: [],
  VYAPAR: [],
  GENERIC_FILE: [],
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "never";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong. Please try again.");
  return data;
}

export function IntegrationSettings({ shopId, providers, integration, tokens, ready, canManage, zohoOutcome }: Props) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string | null>(integration?.provider ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    zohoOutcome?.outcome === "connected" ? "Zoho Books is connected." : null,
  );
  const [newToken, setNewToken] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<string | null>(null);
  const base = `/api/shops/${shopId}/integration`;

  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const provider = providers.find((p) => p.provider === chosen) ?? null;

  return (
    <div className="space-y-4">
      {zohoOutcome?.outcome === "error" ? <Alert tone="danger" title="Zoho Books was not connected">{zohoOutcome.reason ?? "Please try again."}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!ready.encryption ? (
        <Alert tone="warning" title="Not available yet on this server">
          Connections that need a password or key cannot be saved until GoKesari sets up secure storage. Tally and file sync work without it.
        </Alert>
      ) : null}

      {integration ? (
        <StatusCard
          integration={integration}
          busy={busy}
          canManage={canManage}
          onTest={() => act(async () => {
            const r = await call(`${base}/test`, "POST");
            if (!r.ok) throw new Error(`${r.message} ${r.fix ?? ""}`.trim());
            return r.message;
          })}
          onSync={() => act(async () => {
            const r = await call(`${base}/sync`, "POST");
            return r.queued ? "Reading items from your software now. Results appear in the sync log." : "A sync is already waiting — it will run shortly.";
          })}
          onPause={(paused) => act(async () => {
            await call(base, "PUT", { provider: integration.provider, config: {}, paused });
            return paused ? "Sync paused. Nothing is sent or read until you resume." : "Sync resumed.";
          })}
          onDisconnect={() => {
            if (!window.confirm(`Disconnect ${integration.label}? Saved keys are deleted, connector tokens stop working and entries not yet sent are cancelled.`)) return;
            void act(async () => {
              await call(`${base}/disconnect`, "POST");
              setChosen(null);
              return "Disconnected.";
            });
          }}
        />
      ) : (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">Which software does your shop use?</h2>
          <p className="mt-1 text-sm text-ink-500">GoKesari sends each delivered order to it as a sales invoice, and reads your stock, prices and tax rates from it.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {providers.map((p) => (
              <button
                key={p.provider}
                type="button"
                onClick={() => setChosen(p.provider)}
                className={`rounded-lg border p-3 text-left text-sm ${chosen === p.provider ? "border-kesari-500 bg-kesari-50" : "border-cream-200 bg-white hover:bg-cream-100"}`}
              >
                <span className="font-medium text-ink-900">{p.label}</span>
                {p.presetConfirmed === false && p.provider !== "GENERIC_FILE" ? <span className="ml-2"><Badge tone="warning">columns to confirm</Badge></span> : null}
                <span className="mt-1 block text-xs text-ink-500">{p.description}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {provider && canManage ? (
        <ConnectForm
          key={`${provider.provider}-${integration?.id ?? "new"}`}
          shopId={shopId}
          provider={provider}
          integration={integration}
          ready={ready}
          busy={busy}
          onSave={(payload) => act(async () => {
            await call(base, "PUT", payload);
            return integration ? "Settings saved." : `Connected to ${provider.label}.`;
          })}
        />
      ) : null}

      {integration?.transport === "CONNECTOR" ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-semibold text-ink-900">GoKesari Connector on your shop computer</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
            <li>In TallyPrime: F1 Help → Settings → Connectivity → TallyPrime acts as <b>Both</b>, port <b>9000</b>.</li>
            <li>Press <b>New connector token</b> below and copy it.</li>
            <li>Install the GoKesari Connector on the computer where Tally runs and paste the token (ask GoKesari support for the installer).</li>
            <li>Keep Tally open with your company loaded. This page shows “Connector online” within a minute.</li>
          </ol>
          {newToken ? (
            <Alert tone="success" title="Copy this token now — it is shown only once">
              <code className="block break-all rounded bg-white p-2 text-xs text-ink-900">{newToken}</code>
            </Alert>
          ) : null}
          <ul className="divide-y divide-cream-200 text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <code>{t.prefix}…</code> {t.label ? `· ${t.label}` : ""}
                  <span className="block text-xs text-ink-500">
                    {t.revokedAt ? `Removed ${fmt(t.revokedAt)}` : `Last used ${fmt(t.lastUsedAt)}${t.lastConnectorVersion ? ` · v${t.lastConnectorVersion}` : ""}`}
                  </span>
                </span>
                {!t.revokedAt && canManage ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
                    if (!window.confirm("Remove this computer's token? Its connector stops working at once.")) return;
                    void act(async () => {
                      await call(`${base}/tokens/${t.id}`, "DELETE");
                      return "Token removed.";
                    });
                  }}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <Button disabled={busy} onClick={() => act(async () => {
              const label = window.prompt("Name this computer (optional), e.g. Billing counter") ?? "";
              const r = await call(`${base}/tokens`, "POST", { label: label || undefined });
              setNewToken(r.token);
            })}>
              New connector token
            </Button>
          ) : null}
        </Card>
      ) : null}

      {integration?.transport === "API" && canManage ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-semibold text-ink-900">Update GoKesari when items change (optional)</h2>
          <p className="text-sm text-ink-500">
            Set this address as a webhook in {integration.label} for item changes ({integration.provider === "ODOO" ? "Settings → Technical → Automation Rules → Send Webhook Notification" : "Settings → Automation → Webhooks"}). Otherwise use Sync now.
          </p>
          {webhook ? <code className="block break-all rounded bg-cream-100 p-2 text-xs">{webhook}</code> : null}
          <Button variant="secondary" disabled={busy} onClick={() => act(async () => {
            const r = await call(`${base}/webhook`, "POST");
            setWebhook(r.url);
            return "New webhook address created. The old one (if any) no longer works.";
          })}>
            {integration.webhookConfigured ? "Create a new webhook address" : "Create webhook address"}
          </Button>
        </Card>
      ) : null}

      {integration ? (
        <div className="flex flex-wrap gap-2">
          <Link className="text-sm font-medium text-kesari-600 hover:underline" href={`/shop/settings/integrations/mapping?shop=${shopId}`}>
            Match items ({integration.items.suggested + integration.items.unmatched} to check) →
          </Link>
          <Link className="text-sm font-medium text-kesari-600 hover:underline" href={`/shop/settings/integrations/sync?shop=${shopId}`}>
            Sync log and errors →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function StatusCard({
  integration,
  busy,
  canManage,
  onTest,
  onSync,
  onPause,
  onDisconnect,
}: {
  integration: IntegrationInfo;
  busy: boolean;
  canManage: boolean;
  onTest: () => void;
  onSync: () => void;
  onPause: (paused: boolean) => void;
  onDisconnect: () => void;
}) {
  const tone = integration.status === "ACTIVE" ? "success" : integration.status === "PAUSED" ? "neutral" : "danger";
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-900">{integration.label}</h2>
        <span className="flex gap-1">
          <Badge tone={tone}>{integration.status === "ACTIVE" ? "Connected" : integration.status === "PAUSED" ? "Paused" : "Needs attention"}</Badge>
          {integration.connectorOnline != null ? (
            <Badge tone={integration.connectorOnline ? "success" : "warning"}>{integration.connectorOnline ? "Connector online" : "Connector offline"}</Badge>
          ) : null}
        </span>
      </div>
      {integration.lastError ? (
        <Alert tone="danger" title={integration.lastError.message}>
          {integration.lastError.fix}
        </Alert>
      ) : null}
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-500">Items read</dt><dd>{fmt(integration.lastPullAt)}</dd></div>
        <div><dt className="text-xs text-ink-500">Invoices sent</dt><dd>{fmt(integration.lastPushAt)}</dd></div>
        <div><dt className="text-xs text-ink-500">Waiting / retrying</dt><dd>{integration.jobs.waiting} / {integration.jobs.retrying}</dd></div>
        <div><dt className="text-xs text-ink-500">Failed</dt><dd className={integration.jobs.failed ? "font-semibold text-red-700" : ""}>{integration.jobs.failed}</dd></div>
      </dl>
      <p className="text-xs text-ink-500">
        Items: {integration.items.matched} matched, {integration.items.suggested} suggested, {integration.items.unmatched} not matched
        {integration.items.withIssue ? `, ${integration.items.withIssue} with a problem` : ""}.
      </p>
      <div className="flex flex-wrap gap-2">
        {integration.transport !== "FILE" ? (
          <>
            <Button size="sm" disabled={busy} onClick={onSync}>Sync now</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onTest}>Test connection</Button>
          </>
        ) : null}
        {canManage ? (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPause(integration.status !== "PAUSED")}>
              {integration.status === "PAUSED" ? "Resume sync" : "Pause sync"}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={onDisconnect}>Disconnect</Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

function ConnectForm({
  shopId,
  provider,
  integration,
  ready,
  busy,
  onSave,
}: {
  shopId: string;
  provider: ProviderInfo;
  integration: IntegrationInfo | null;
  ready: { encryption: boolean; zoho: boolean };
  busy: boolean;
  onSave: (payload: { provider: string; config: Record<string, unknown>; credentials?: Record<string, unknown> }) => void;
}) {
  const current = (integration?.provider === provider.provider ? integration.config : {}) as Record<string, unknown>;
  const pull = (current.pull ?? {}) as Record<string, unknown>;
  const push = (current.push ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = { ...current };
    if (provider.provider === "ODOO" && v.adjustStock === undefined) v.adjustStock = true;
    return v;
  });
  const [secret, setSecret] = useState("");
  const [sync, setSync] = useState({
    stock: pull.stock !== false,
    price: pull.price !== false,
    tax: pull.tax !== false,
    priceChannels: (pull.priceChannels as string) ?? "BOTH",
    stockTo: (pull.stockTo as string) ?? "ONLINE",
    invoices: push.invoices !== false,
    creditNotes: push.creditNotes !== false,
  });
  const fields = PROVIDER_FIELDS[provider.provider] ?? [];
  const organizations = (current.organizations ?? []) as { id: string; name: string }[];

  if (provider.oauth && (!integration || integration.provider !== provider.provider)) {
    return (
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-semibold text-ink-900">Connect {provider.label}</h2>
        <p className="text-sm text-ink-500">You sign in to Zoho and allow GoKesari to create invoices and read items in your Zoho Books (India). GoKesari never sees your Zoho password.</p>
        {!ready.zoho || !ready.encryption ? (
          <Alert tone="warning">Zoho Books is not available on this server yet. Contact GoKesari support.</Alert>
        ) : (
          <a className="inline-flex rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800" href={`/api/integrations/zoho/connect?shopId=${shopId}`}>
            Connect Zoho Books
          </a>
        )}
      </Card>
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const config: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (f.type === "number") {
        if (v !== undefined && v !== "" && v !== null) config[f.key] = Number(v);
      } else if (f.type === "checkbox") {
        config[f.key] = Boolean(v);
      } else if (typeof v === "string" && v.trim() !== "") {
        config[f.key] = v.trim();
      }
    }
    if (provider.oauth && values.organizationId) config.organizationId = values.organizationId;
    config.pull = { stock: sync.stock, price: sync.price, tax: sync.tax, priceChannels: sync.priceChannels, stockTo: sync.stockTo };
    config.push = { invoices: sync.invoices, creditNotes: sync.creditNotes };
    onSave({
      provider: provider.provider,
      config,
      ...(provider.secretFields.length && secret.trim() ? { credentials: { [provider.secretFields[0]]: secret.trim() } } : {}),
    });
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-3">
        <h2 className="text-base font-semibold text-ink-900">{integration ? "Settings" : `Connect ${provider.label}`}</h2>
        {provider.transport === "FILE" ? (
          <p className="text-sm text-ink-500">
            You upload your item list exported from {provider.label} (Excel or CSV) and download GoKesari sales to import into it.
            {provider.presetConfirmed === false && provider.provider !== "GENERIC_FILE" ? " GoKesari guesses the columns; check them the first time." : ""}
          </p>
        ) : null}
        {provider.oauth && organizations.length > 0 ? (
          <Field label="Zoho Books organisation">
            <select className={inputClass} value={String(values.organizationId ?? "")} onChange={(e) => setValues({ ...values, organizationId: e.target.value })} required>
              <option value="">Choose…</option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        {fields.map((f) =>
          f.type === "checkbox" ? (
            <label key={f.key} className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />
              {f.label}
            </label>
          ) : f.type === "select" ? (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <select className={inputClass} value={String(values[f.key] ?? f.options?.[0]?.[0] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                {f.options?.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                className={inputClass}
                type={f.type === "number" ? "number" : "text"}
                value={String(values[f.key] ?? "")}
                placeholder={f.placeholder}
                required={f.required}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            </Field>
          ),
        )}
        {provider.secretFields.map((key) => (
          <Field key={key} label="API key" hint={integration?.hasCredentials ? "A key is saved. Leave empty to keep it, or paste a new one." : "Odoo: Preferences → Account Security → New API Key."}>
            <input className={inputClass} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} required={!integration?.hasCredentials} />
          </Field>
        ))}

        <fieldset className="space-y-2 rounded-lg border border-cream-200 p-3">
          <legend className="px-1 text-sm font-medium text-ink-700">What to sync</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync.invoices} onChange={(e) => setSync({ ...sync, invoices: e.target.checked })} /> Send a sales invoice for every delivered order</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync.creditNotes} onChange={(e) => setSync({ ...sync, creditNotes: e.target.checked })} /> Send a credit note for every refund or return</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync.stock} onChange={(e) => setSync({ ...sync, stock: e.target.checked })} /> Take stock from my software</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync.price} onChange={(e) => setSync({ ...sync, price: e.target.checked })} /> Take selling prices from my software</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync.tax} onChange={(e) => setSync({ ...sync, tax: e.target.checked })} /> Take HSN and GST rate from my software</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Price goes to">
              <select className={inputClass} value={sync.priceChannels} onChange={(e) => setSync({ ...sync, priceChannels: e.target.value })}>
                <option value="BOTH">Online and in-shop price</option>
                <option value="ONLINE">Online price only</option>
              </select>
            </Field>
            <Field label="Stock goes to">
              <select className={inputClass} value={sync.stockTo} onChange={(e) => setSync({ ...sync, stockTo: e.target.value })}>
                <option value="ONLINE">Online stock</option>
                <option value="BOTH">Online and in-shop stock</option>
              </select>
            </Field>
          </div>
          <p className="text-xs text-ink-500">Your software decides stock and price. Online stock = stock in your software minus items already sold online and not yet in your software. A price above the product&apos;s MRP is not used and is shown as a problem.</p>
        </fieldset>
        <Button type="submit" disabled={busy}>{integration ? "Save settings" : "Connect"}</Button>
      </form>
    </Card>
  );
}
