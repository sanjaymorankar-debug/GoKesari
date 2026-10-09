/**
 * A shop's connection to its accounting / inventory software (Module 2):
 * who may see and change it, connecting and disconnecting, the connector's
 * sign-in tokens, change webhooks, the mapping screen and the support view.
 *
 * Access:
 *   OWNER    the shop's owner — everything for their own shop only;
 *   SUPPORT  operators (INTEGRATION_VIEW_ANY) see status, log and items and
 *            may retry; administrators (INTEGRATION_MANAGE_ANY) may also
 *            change the connection. Every change is audited.
 * Shop staff (Module 1) have no access. Credentials are write-only for
 * everyone: the API says only which fields are set, never their values.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, unauthenticated, validationFailed } from "@/lib/errors";
import { requireUser, type AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  INTEGRATION_PROVIDERS,
  integrationConnectorTokens,
  integrationItemLinks,
  integrationJobs,
  products,
  shopIntegrations,
  shopProducts,
  shops,
  type IntegrationProvider,
  type ShopIntegration,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { CREDENTIALS_KEY_VERSION, encryptCredentials, isCredentialEncryptionConfigured } from "./credentials";
import { asIntegrationError, describeError } from "./errors";
import { contextFor, enqueueJob, liveIntegration, logSync, scheduleDispatch } from "./jobs";
import { applyLinkNow, rematchLinks } from "./pull";
import { ADAPTERS, adapterFor, isApiAdapter, isConnectorAdapter, isFileAdapter } from "./registry";

/* -------------------------------------------------------------- access */

export type IntegrationAccessVia = "OWNER" | "SUPPORT";
export type IntegrationAccessMode = "view" | "operate" | "manage";

export interface IntegrationActor {
  id: string;
  role: UserRole;
  via: IntegrationAccessVia;
}

/**
 * view     status, items, log;
 * operate  + sync now, retry, match items, upload files (support may help);
 * manage   connect, change settings and secrets, tokens, disconnect.
 */
export async function integrationAccessFor(
  shopId: string,
  actor: { id: string; role: UserRole },
  mode: IntegrationAccessMode,
): Promise<IntegrationAccessVia | null> {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) return null;
  if (shop.ownerId === actor.id) return "OWNER";
  if (mode === "manage") return can(actor.role, PERMISSIONS.INTEGRATION_MANAGE_ANY) ? "SUPPORT" : null;
  return can(actor.role, PERMISSIONS.INTEGRATION_VIEW_ANY) ? "SUPPORT" : null;
}

export async function assertIntegrationAccess(
  shopId: string,
  user: { id: string; role: UserRole },
  mode: IntegrationAccessMode,
): Promise<IntegrationActor> {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const via = await integrationAccessFor(shopId, user, mode);
  if (!via) throw forbidden("Only the shop's owner can change its accounting connection.");
  return { id: user.id, role: user.role, via };
}

export async function requireIntegrationAccess(shopId: string, mode: IntegrationAccessMode): Promise<IntegrationActor> {
  const user: AuthenticatedUser = await requireUser();
  return assertIntegrationAccess(shopId, user, mode);
}

async function requireLive(shopId: string): Promise<ShopIntegration> {
  const integration = await liveIntegration(shopId);
  if (!integration) throw notFound("Accounting connection");
  return integration;
}

/* --------------------------------------------------------------- views */

export interface ProviderInfo {
  provider: IntegrationProvider;
  label: string;
  description: string;
  transport: "API" | "CONNECTOR" | "FILE";
  /** Secret fields the owner types in (Odoo: apiKey). Zoho uses "Connect Zoho" instead. */
  secretFields: string[];
  oauth: boolean;
  /** File presets only: whether the column guess is checked against a real export. */
  presetConfirmed: boolean | null;
}

export function providerCatalogue(): ProviderInfo[] {
  return INTEGRATION_PROVIDERS.map((provider) => {
    const a = ADAPTERS[provider];
    return {
      provider,
      label: a.label,
      description: a.description,
      transport: a.transport,
      secretFields: provider === "ODOO" ? ["apiKey"] : [],
      oauth: provider === "ZOHO_BOOKS",
      presetConfirmed: isFileAdapter(a) ? a.presetConfirmed : null,
    };
  });
}

/** The connector counts as online if it called in within this many seconds (it long-polls every ~25 s). */
export const CONNECTOR_ONLINE_SECONDS = 120;

export interface IntegrationView {
  id: string;
  shopId: string;
  provider: IntegrationProvider;
  label: string;
  transport: "API" | "CONNECTOR" | "FILE";
  status: ShopIntegration["status"];
  config: Record<string, unknown>;
  /** Which secrets are stored (never their values). */
  hasCredentials: boolean;
  webhookConfigured: boolean;
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  lastError: { code: string; message: string; fix: string; at: Date | null } | null;
  connectorSeenAt: Date | null;
  connectorOnline: boolean | null;
  jobs: { waiting: number; retrying: number; failed: number };
  items: { matched: number; suggested: number; unmatched: number; ignored: number; withIssue: number };
  connectedAt: Date;
}

export async function integrationView(integration: ShopIntegration): Promise<IntegrationView> {
  const adapter = adapterFor(integration.provider);
  const jobRows = await db
    .select({ status: integrationJobs.status, n: count() })
    .from(integrationJobs)
    .where(and(eq(integrationJobs.integrationId, integration.id), inArray(integrationJobs.status, ["PENDING", "CLAIMED", "FAILED", "DEAD"])))
    .groupBy(integrationJobs.status);
  const jobsBy = Object.fromEntries(jobRows.map((r) => [r.status, Number(r.n)]));
  const itemRows = await db
    .select({
      status: integrationItemLinks.matchStatus,
      n: count(),
      issues: sql<number>`count(*) filter (where ${integrationItemLinks.lastIssue} is not null)`,
    })
    .from(integrationItemLinks)
    .where(eq(integrationItemLinks.integrationId, integration.id))
    .groupBy(integrationItemLinks.matchStatus);
  const itemsBy = Object.fromEntries(itemRows.map((r) => [r.status, Number(r.n)]));
  const err = integration.lastErrorCode ? describeError(integration.lastErrorCode) : null;
  return {
    id: integration.id,
    shopId: integration.shopId,
    provider: integration.provider,
    label: adapter.label,
    transport: adapter.transport,
    status: integration.status,
    config: integration.config,
    hasCredentials: Boolean(integration.credentialsEncrypted),
    webhookConfigured: Boolean(integration.webhookSecretHash),
    lastPullAt: integration.lastPullAt,
    lastPushAt: integration.lastPushAt,
    lastError: err ? { code: integration.lastErrorCode!, message: err.message, fix: err.fix, at: integration.lastErrorAt } : null,
    connectorSeenAt: integration.connectorSeenAt,
    connectorOnline: isConnectorAdapter(adapter)
      ? Boolean(integration.connectorSeenAt && Date.now() - integration.connectorSeenAt.getTime() < CONNECTOR_ONLINE_SECONDS * 1000)
      : null,
    jobs: {
      waiting: (jobsBy.PENDING ?? 0) + (jobsBy.CLAIMED ?? 0),
      retrying: jobsBy.FAILED ?? 0,
      failed: jobsBy.DEAD ?? 0,
    },
    items: {
      matched: itemsBy.MATCHED ?? 0,
      suggested: itemsBy.SUGGESTED ?? 0,
      unmatched: itemsBy.UNMATCHED ?? 0,
      ignored: itemsBy.IGNORED ?? 0,
      withIssue: itemRows.reduce((s, r) => s + Number(r.issues), 0),
    },
    connectedAt: integration.connectedAt,
  };
}

export async function getIntegrationView(shopId: string): Promise<IntegrationView | null> {
  const integration = await liveIntegration(shopId);
  return integration ? integrationView(integration) : null;
}

/* ----------------------------------------------------- connect / change */

/** Settings common to every software: what to sync. */
export const syncOptionsSchema = z.object({
  pull: z
    .object({
      stock: z.boolean().default(true),
      price: z.boolean().default(true),
      tax: z.boolean().default(true),
      priceChannels: z.enum(["BOTH", "ONLINE"]).default("BOTH"),
      stockTo: z.enum(["ONLINE", "BOTH"]).default("ONLINE"),
    })
    .default({ stock: true, price: true, tax: true, priceChannels: "BOTH", stockTo: "ONLINE" }),
  push: z
    .object({ invoices: z.boolean().default(true), creditNotes: z.boolean().default(true) })
    .default({ invoices: true, creditNotes: true }),
});

export const saveIntegrationSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Write-only. Omit to keep what is stored. */
  credentials: z.record(z.string(), z.unknown()).optional(),
  paused: z.boolean().optional(),
});
export type SaveIntegrationInput = z.infer<typeof saveIntegrationSchema>;

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

/** Validates the software's own settings and the common sync options, keeping both. */
export function validateConfig(provider: IntegrationProvider, config: Record<string, unknown>): Record<string, unknown> {
  const adapter = adapterFor(provider);
  const own = adapter.configSchema.safeParse(config);
  if (!own.success) throw validationFailed(`Check the settings — ${issuesText(own.error)}`);
  const common = syncOptionsSchema.safeParse({ pull: config.pull, push: config.push });
  if (!common.success) throw validationFailed(`Check the sync options — ${issuesText(common.error)}`);
  return { ...own.data, ...common.data };
}

export async function saveIntegration(shopId: string, input: SaveIntegrationInput, actor: IntegrationActor): Promise<IntegrationView> {
  const adapter = adapterFor(input.provider);
  const existing = await liveIntegration(shopId);
  if (existing && existing.provider !== input.provider) {
    throw conflict(`This shop is connected to ${adapterFor(existing.provider).label}. Disconnect it first to switch software.`);
  }
  if (input.provider === "ZOHO_BOOKS") {
    if (input.credentials) throw validationFailed("Zoho Books is connected with the Connect Zoho button, not by typing keys.");
    if (!existing) throw validationFailed("Press Connect Zoho Books first.");
  }
  // Zoho's organisation list (saved at sign-in) stays with the settings.
  const config = validateConfig(input.provider, { ...(existing?.config ?? {}), ...input.config });
  let credentialsEncrypted = existing?.credentialsEncrypted ?? null;
  if (input.credentials) {
    const creds = adapter.credentialsSchema.safeParse(input.credentials);
    if (!creds.success) throw validationFailed(`Check the key — ${issuesText(creds.error)}`);
    if (!isCredentialEncryptionConfigured()) encryptCredentials({}); // throws the owner-facing message
    credentialsEncrypted = encryptCredentials(creds.data);
  }
  if (isApiAdapter(adapter) && input.provider === "ODOO" && !credentialsEncrypted) {
    throw validationFailed("Enter the Odoo API key.");
  }
  const now = new Date();
  const paused = input.paused ?? existing?.status === "PAUSED";
  let row: ShopIntegration;
  if (existing) {
    const status: ShopIntegration["status"] = paused ? "PAUSED" : existing.status === "PAUSED" || input.credentials ? "ACTIVE" : existing.status;
    [row] = await db
      .update(shopIntegrations)
      .set({
        config,
        credentialsEncrypted,
        keyVersion: credentialsEncrypted ? CREDENTIALS_KEY_VERSION : null,
        status,
        ...(input.credentials ? { lastErrorCode: null, lastErrorAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(shopIntegrations.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(shopIntegrations)
      .values({
        shopId,
        provider: input.provider,
        status: paused ? "PAUSED" : "ACTIVE",
        config,
        credentialsEncrypted,
        keyVersion: credentialsEncrypted ? CREDENTIALS_KEY_VERSION : null,
        connectedBy: actor.id,
        connectedAt: now,
      })
      .returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: existing ? AUDIT_ACTIONS.INTEGRATION_UPDATED : AUDIT_ACTIONS.INTEGRATION_CONNECTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: existing ? { provider: existing.provider, status: existing.status, config: existing.config } : null,
    newValue: { provider: row.provider, status: row.status, config, credentialsChanged: Boolean(input.credentials), via: actor.via },
  });
  await logSync(row, {
    level: "INFO",
    event: existing ? "settings.changed" : "connected",
    message: existing
      ? `Settings changed${input.credentials ? " (new key saved)" : ""}${row.status === "PAUSED" ? " — sync paused" : ""}.`
      : `Connected to ${adapter.label}.`,
  });
  // A new API connection reads the software's items straight away.
  if (!existing && isApiAdapter(adapter) && row.status === "ACTIVE") await requestPull(shopId, "connected");
  return integrationView(row);
}

/** Zoho Books after its consent screen: stores the refresh token (encrypted) and the organisations to choose from. */
export async function saveZohoConnection(
  shopId: string,
  tokens: { refreshToken: string; accessToken: string; expiresIn: number },
  organizations: { id: string; name: string }[],
  actor: IntegrationActor,
): Promise<ShopIntegration> {
  const existing = await liveIntegration(shopId);
  if (existing && existing.provider !== "ZOHO_BOOKS") {
    throw conflict(`This shop is connected to ${adapterFor(existing.provider).label}. Disconnect it first.`);
  }
  const credentialsEncrypted = encryptCredentials({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
  });
  const previous = (existing?.config ?? {}) as Record<string, unknown>;
  const keep = organizations.some((o) => o.id === previous.organizationId) ? (previous.organizationId as string) : null;
  const config: Record<string, unknown> = {
    ...syncOptionsSchema.parse({ pull: previous.pull, push: previous.push }),
    customerName: (previous.customerName as string) ?? "GoKesari Online Customers",
    organizations,
    ...(keep ? { organizationId: keep } : organizations.length === 1 ? { organizationId: organizations[0].id } : {}),
  };
  const now = new Date();
  const [row] = existing
    ? await db
        .update(shopIntegrations)
        .set({ config, credentialsEncrypted, keyVersion: CREDENTIALS_KEY_VERSION, status: "ACTIVE", lastErrorCode: null, lastErrorAt: null, updatedAt: now })
        .where(eq(shopIntegrations.id, existing.id))
        .returning()
    : await db
        .insert(shopIntegrations)
        .values({ shopId, provider: "ZOHO_BOOKS", status: "ACTIVE", config, credentialsEncrypted, keyVersion: CREDENTIALS_KEY_VERSION, connectedBy: actor.id })
        .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: existing ? AUDIT_ACTIONS.INTEGRATION_UPDATED : AUDIT_ACTIONS.INTEGRATION_CONNECTED,
    entityType: "shop",
    entityId: shopId,
    newValue: { provider: "ZOHO_BOOKS", reconnected: Boolean(existing), organizations: organizations.length, via: actor.via },
  });
  await logSync(row, { level: "INFO", event: existing ? "reconnected" : "connected", message: existing ? "Zoho Books reconnected." : "Connected to Zoho Books." });
  if (config.organizationId) await requestPull(shopId, "connected");
  return row;
}

export async function disconnectIntegration(shopId: string, actor: IntegrationActor): Promise<void> {
  const integration = await requireLive(shopId);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(shopIntegrations)
      .set({ status: "DISCONNECTED", credentialsEncrypted: null, keyVersion: null, webhookSecretHash: null, disconnectedAt: now, updatedAt: now })
      .where(eq(shopIntegrations.id, integration.id));
    await tx
      .update(integrationConnectorTokens)
      .set({ revokedAt: now })
      .where(and(eq(integrationConnectorTokens.integrationId, integration.id), isNull(integrationConnectorTokens.revokedAt)));
    await tx
      .update(integrationJobs)
      .set({ status: "CANCELLED", leaseUntil: null, updatedAt: now })
      .where(and(eq(integrationJobs.integrationId, integration.id), inArray(integrationJobs.status, ["PENDING", "CLAIMED", "FAILED", "DEAD"])));
    await logSync(integration, { level: "INFO", event: "disconnected", message: "Disconnected. Entries not yet sent were cancelled." }, tx);
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_DISCONNECTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { provider: integration.provider, status: integration.status },
    newValue: { via: actor.via },
  });
}

/* ------------------------------------------------------ test / sync now */

export interface TestOutcome {
  ok: boolean;
  message: string;
  fix?: string;
}

export async function testIntegration(shopId: string): Promise<TestOutcome> {
  const integration = await requireLive(shopId);
  const adapter = adapterFor(integration.provider);
  if (isFileAdapter(adapter)) return { ok: true, message: "Nothing to test for file sync: upload your item export to sync." };
  if (isConnectorAdapter(adapter)) {
    const online = Boolean(integration.connectorSeenAt && Date.now() - integration.connectorSeenAt.getTime() < CONNECTOR_ONLINE_SECONDS * 1000);
    await enqueueJob({ integration, kind: "TEST_CONNECTION", idempotencyKey: `test:${integration.id}:${Date.now()}` });
    if (!online) {
      const info = describeError("CONNECTOR_OFFLINE");
      return { ok: false, message: info.message, fix: info.fix };
    }
    return { ok: true, message: "The connector is online. A test was sent to Tally — the result appears in the sync log in a few seconds." };
  }
  try {
    const message = await adapter.testConnection(contextFor(integration, null));
    await db
      .update(shopIntegrations)
      .set({ lastErrorCode: null, lastErrorAt: null, status: integration.status === "ERROR" ? "ACTIVE" : integration.status, updatedAt: new Date() })
      .where(eq(shopIntegrations.id, integration.id));
    await logSync(integration, { level: "INFO", event: "test.succeeded", message: `Connection test passed: ${message}` });
    return { ok: true, message };
  } catch (error) {
    const e = asIntegrationError(error);
    const info = describeError(e.code);
    await logSync(integration, { level: "WARN", event: "test.failed", message: `Connection test failed: ${info.message}`, detail: { code: e.code, detail: e.detail?.slice(0, 1000) ?? null } });
    return { ok: false, message: info.message, fix: info.fix };
  }
}

/**
 * Asks for the software's items now (Sync now, a new connection, a change
 * webhook). One pull at a time: while one is waiting, asking again is a no-op.
 */
export async function requestPull(shopId: string, reason: "owner" | "connected" | "webhook" | "connector"): Promise<{ jobId: string; queued: boolean }> {
  const integration = await requireLive(shopId);
  const adapter = adapterFor(integration.provider);
  if (isFileAdapter(adapter)) throw validationFailed("This connection syncs by file: upload your item export instead.");
  if (integration.status === "PAUSED") throw conflict("Sync is paused. Resume it in the connection settings first.");
  const [waiting] = await db
    .select({ id: integrationJobs.id })
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.integrationId, integration.id),
        eq(integrationJobs.kind, "PULL_ITEMS"),
        inArray(integrationJobs.status, ["PENDING", "CLAIMED", "FAILED"]),
      ),
    )
    .limit(1);
  if (waiting) return { jobId: waiting.id, queued: false };
  const job = await enqueueJob({
    integration,
    kind: "PULL_ITEMS",
    idempotencyKey: `pull:${integration.id}:${Date.now()}:${randomBytes(3).toString("hex")}`,
    payload: { reason },
  });
  return { jobId: job.id, queued: true };
}

/* ------------------------------------------------- connector sign-in */

export const CONNECTOR_TOKEN_PREFIX = "gkc_";
const MAX_ACTIVE_TOKENS = 5;

export const hashSecret = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A new connector token. The token itself is returned once and never stored. */
export async function issueConnectorToken(shopId: string, label: string | null, actor: IntegrationActor) {
  const integration = await requireLive(shopId);
  if (!isConnectorAdapter(adapterFor(integration.provider))) throw validationFailed("Connector tokens are only for Tally.");
  const [{ n }] = await db
    .select({ n: count() })
    .from(integrationConnectorTokens)
    .where(and(eq(integrationConnectorTokens.integrationId, integration.id), isNull(integrationConnectorTokens.revokedAt)));
  if (Number(n) >= MAX_ACTIVE_TOKENS) throw conflict(`At most ${MAX_ACTIVE_TOKENS} computers can be connected. Remove an old one first.`);
  const token = `${CONNECTOR_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(integrationConnectorTokens)
    .values({
      integrationId: integration.id,
      shopId,
      tokenHash: hashSecret(token),
      prefix: token.slice(0, CONNECTOR_TOKEN_PREFIX.length + 6),
      label: label?.trim() || null,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_TOKEN_ISSUED,
    entityType: "shop",
    entityId: shopId,
    newValue: { tokenId: row.id, prefix: row.prefix, label: row.label, via: actor.via },
  });
  return { id: row.id, prefix: row.prefix, label: row.label, createdAt: row.createdAt, token };
}

export async function listConnectorTokens(shopId: string) {
  const integration = await liveIntegration(shopId);
  if (!integration) return [];
  return db
    .select({
      id: integrationConnectorTokens.id,
      prefix: integrationConnectorTokens.prefix,
      label: integrationConnectorTokens.label,
      createdAt: integrationConnectorTokens.createdAt,
      lastUsedAt: integrationConnectorTokens.lastUsedAt,
      lastConnectorVersion: integrationConnectorTokens.lastConnectorVersion,
      revokedAt: integrationConnectorTokens.revokedAt,
    })
    .from(integrationConnectorTokens)
    .where(eq(integrationConnectorTokens.integrationId, integration.id))
    .orderBy(desc(integrationConnectorTokens.createdAt));
}

export async function revokeConnectorToken(shopId: string, tokenId: string, actor: IntegrationActor): Promise<void> {
  const [row] = await db
    .update(integrationConnectorTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(integrationConnectorTokens.id, tokenId), eq(integrationConnectorTokens.shopId, shopId), isNull(integrationConnectorTokens.revokedAt)))
    .returning();
  if (!row) throw notFound("Connector token");
  // Jobs the revoked connector held go back to the queue at once.
  await db
    .update(integrationJobs)
    .set({ status: "PENDING", leaseUntil: null, claimedBy: null, updatedAt: new Date() })
    .where(and(eq(integrationJobs.integrationId, row.integrationId), eq(integrationJobs.status, "CLAIMED"), eq(integrationJobs.claimedBy, row.id)));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_TOKEN_REVOKED,
    entityType: "shop",
    entityId: shopId,
    newValue: { tokenId, prefix: row.prefix, via: actor.via },
  });
}

export interface ConnectorSession {
  integration: ShopIntegration;
  tokenId: string;
}

/**
 * The connector's bearer token → its one shop and one connection. A revoked
 * token, a disconnected shop or another software's connection is refused.
 */
export async function authenticateConnector(request: Request): Promise<ConnectorSession> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(gkc_[A-Za-z0-9_-]{20,100})$/.exec(header.trim());
  if (!m) throw unauthenticated("Connector token missing.");
  const [row] = await db
    .select({ token: integrationConnectorTokens, integration: shopIntegrations })
    .from(integrationConnectorTokens)
    .innerJoin(shopIntegrations, eq(shopIntegrations.id, integrationConnectorTokens.integrationId))
    .where(and(eq(integrationConnectorTokens.tokenHash, hashSecret(m[1])), isNull(integrationConnectorTokens.revokedAt)));
  if (!row || row.integration.status === "DISCONNECTED" || !isConnectorAdapter(adapterFor(row.integration.provider))) {
    throw unauthenticated("This connector token is not valid. Create a new one in Shop settings → Integrations.");
  }
  const now = new Date();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
  const version = request.headers.get("x-connector-version")?.slice(0, 40) ?? null;
  await db
    .update(integrationConnectorTokens)
    .set({ lastUsedAt: now, lastUsedIp: ip, ...(version ? { lastConnectorVersion: version } : {}) })
    .where(eq(integrationConnectorTokens.id, row.token.id));
  const [integration] = await db
    .update(shopIntegrations)
    .set({ connectorSeenAt: now })
    .where(eq(shopIntegrations.id, row.integration.id))
    .returning();
  return { integration, tokenId: row.token.id };
}

/* ------------------------------------------------------ change webhooks */

/** A new secret for the software's change webhook (Odoo automated action, Zoho webhook). Shown once. */
export async function issueWebhookSecret(shopId: string, origin: string, actor: IntegrationActor): Promise<{ url: string; secret: string }> {
  const integration = await requireLive(shopId);
  if (!isApiAdapter(adapterFor(integration.provider))) throw validationFailed("Change webhooks are for Odoo and Zoho Books.");
  const secret = randomBytes(24).toString("base64url");
  await db.update(shopIntegrations).set({ webhookSecretHash: hashSecret(secret), updatedAt: new Date() }).where(eq(shopIntegrations.id, integration.id));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_UPDATED,
    entityType: "shop",
    entityId: shopId,
    newValue: { webhookSecretChanged: true, via: actor.via },
  });
  const url = `${origin.replace(/\/$/, "")}/api/integrations/webhooks/${integration.provider.toLowerCase()}/${integration.id}?key=${secret}`;
  return { url, secret };
}

/** A change notice from the software: checks the secret, then asks for a pull (debounced). */
export async function handleChangeWebhook(provider: string, integrationId: string, presented: string | null): Promise<boolean> {
  if (!presented || !/^[0-9a-f-]{36}$/i.test(integrationId)) return false;
  const [integration] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, integrationId));
  if (
    !integration ||
    integration.provider.toLowerCase() !== provider.toLowerCase() ||
    integration.status === "DISCONNECTED" ||
    !integration.webhookSecretHash ||
    !sameHash(hashSecret(presented), integration.webhookSecretHash)
  ) {
    return false;
  }
  if (integration.status !== "PAUSED") await requestPull(integration.shopId, "webhook");
  return true;
}

/* ------------------------------------------------------- mapping screen */

export const itemListSchema = z.object({
  status: z.enum(["MATCHED", "SUGGESTED", "UNMATCHED", "IGNORED", "ISSUE"]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const PAGE_SIZE = 50;

export async function listItemLinks(shopId: string, query: z.infer<typeof itemListSchema>) {
  const integration = await liveIntegration(shopId);
  if (!integration) return { items: [], total: 0, pageSize: PAGE_SIZE };
  const where = and(
    eq(integrationItemLinks.integrationId, integration.id),
    query.status === "ISSUE"
      ? sql`${integrationItemLinks.lastIssue} is not null`
      : query.status
        ? eq(integrationItemLinks.matchStatus, query.status)
        : undefined,
    query.q
      ? or(
          ilike(integrationItemLinks.externalName, `%${query.q}%`),
          ilike(integrationItemLinks.externalSku, `%${query.q}%`),
          ilike(integrationItemLinks.externalBarcode, `%${query.q}%`),
        )
      : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(integrationItemLinks).where(where);
  const rows = await db
    .select({
      link: integrationItemLinks,
      productName: products.name,
      productCode: products.code,
      onlinePricePaise: shopProducts.onlinePricePaise,
      onlineStock: shopProducts.onlineStock,
    })
    .from(integrationItemLinks)
    .leftJoin(products, eq(products.id, integrationItemLinks.productId))
    .leftJoin(shopProducts, eq(shopProducts.id, integrationItemLinks.shopProductId))
    .where(where)
    .orderBy(
      sql`case ${integrationItemLinks.matchStatus} when 'SUGGESTED' then 0 when 'UNMATCHED' then 1 when 'MATCHED' then 2 else 3 end`,
      asc(integrationItemLinks.externalName),
    )
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  return {
    total: Number(total),
    pageSize: PAGE_SIZE,
    items: rows.map((r) => ({
      id: r.link.id,
      externalId: r.link.externalId,
      externalName: r.link.externalName,
      externalSku: r.link.externalSku,
      externalBarcode: r.link.externalBarcode,
      externalUnit: r.link.externalUnit,
      lastSeen: r.link.lastSeen,
      lastSeenAt: r.link.lastSeenAt,
      matchStatus: r.link.matchStatus,
      matchMethod: r.link.matchMethod,
      suggestions: r.link.suggestions,
      product: r.link.productId ? { id: r.link.productId, name: r.productName, code: r.productCode } : null,
      listing: r.link.shopProductId ? { id: r.link.shopProductId, onlinePricePaise: r.onlinePricePaise, onlineStock: r.onlineStock } : null,
      lastAppliedAt: r.link.lastAppliedAt,
      lastIssue: r.link.lastIssue,
    })),
  };
}

export const itemActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), productId: z.string().uuid() }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("unmatch") }),
]);

export async function updateItemLink(
  shopId: string,
  linkId: string,
  input: z.infer<typeof itemActionSchema>,
  actor: IntegrationActor,
): Promise<{ status: string; applied: string | null }> {
  const integration = await requireLive(shopId);
  const link = await db.query.integrationItemLinks.findFirst({
    where: and(eq(integrationItemLinks.id, linkId), eq(integrationItemLinks.integrationId, integration.id)),
  });
  if (!link) throw notFound("Item");
  const now = new Date();
  if (input.action === "match") {
    const product = await db.query.products.findFirst({ where: and(eq(products.id, input.productId), isNull(products.deletedAt)) });
    if (!product) throw notFound("Product");
    // One software item per listing: another item already matched to the same product is a mistake to show, not to merge.
    const [other] = await db
      .select({ name: integrationItemLinks.externalName })
      .from(integrationItemLinks)
      .where(
        and(
          eq(integrationItemLinks.integrationId, integration.id),
          eq(integrationItemLinks.productId, input.productId),
          eq(integrationItemLinks.matchStatus, "MATCHED"),
          ne(integrationItemLinks.id, link.id),
        ),
      )
      .limit(1);
    if (other) throw conflict(`"${other.name}" from your software is already matched to ${product.name}. Unmatch it first.`);
    await db
      .update(integrationItemLinks)
      .set({ productId: product.id, shopProductId: null, matchStatus: "MATCHED", matchMethod: "MANUAL", confirmedBy: actor.id, lastIssue: null, updatedAt: now })
      .where(eq(integrationItemLinks.id, link.id));
  } else if (input.action === "ignore") {
    await db
      .update(integrationItemLinks)
      .set({ matchStatus: "IGNORED", matchMethod: "MANUAL", productId: null, shopProductId: null, confirmedBy: actor.id, lastIssue: null, updatedAt: now })
      .where(eq(integrationItemLinks.id, link.id));
  } else {
    // Back to the automatic matcher's hands.
    await db
      .update(integrationItemLinks)
      .set({ matchStatus: "UNMATCHED", matchMethod: null, productId: null, shopProductId: null, confirmedBy: actor.id, lastIssue: null, updatedAt: now })
      .where(eq(integrationItemLinks.id, link.id));
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_ITEM_MAPPED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { linkId, externalName: link.externalName, status: link.matchStatus, productId: link.productId },
    newValue: { action: input.action, productId: input.action === "match" ? input.productId : null, via: actor.via },
  });
  const applied = input.action === "match" ? await applyLinkNow(integration, link.id) : null;
  return { status: input.action === "match" ? "MATCHED" : input.action === "ignore" ? "IGNORED" : "UNMATCHED", applied };
}

export async function rematchItems(shopId: string) {
  const integration = await requireLive(shopId);
  const result = await rematchLinks(integration);
  await logSync(integration, {
    level: "INFO",
    event: "items.rematched",
    message: `Matching run again: ${result.matched} matched, ${result.suggested} suggested of ${result.checked} unmatched items.`,
  });
  return result;
}

/** GoKesari products to pick from on the mapping screen (the shop's own first). */
export async function searchProductsForMapping(shopId: string, q: string) {
  const term = q.trim();
  if (term.length < 2) return [];
  return db
    .select({
      id: products.id,
      name: products.name,
      code: products.code,
      mrpPaise: products.mrpPaise,
      listed: sql<boolean>`exists (select 1 from ${shopProducts} sp where sp.product_id = ${products.id} and sp.shop_id = ${shopId} and sp.deleted_at is null)`,
    })
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        or(
          ilike(products.name, `%${term}%`),
          eq(products.code, term.toUpperCase()),
          eq(products.gtin, term),
          sql`similarity(lower(${products.name}), ${term.toLowerCase()}) > 0.3`,
        ),
      ),
    )
    .orderBy(sql`5 DESC`, sql`similarity(lower(${products.name}), ${term.toLowerCase()}) DESC`)
    .limit(20);
}

/* ------------------------------------------------------------- support */

export const healthQuerySchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS).optional(),
  problem: z.enum(["any", "failed", "offline"]).optional(),
  q: z.string().trim().max(100).optional(),
});

/** Every connected shop's sync health (operators; no secrets). */
export async function listIntegrationHealth(query: z.infer<typeof healthQuerySchema>) {
  const rows = await db
    .select({
      integration: shopIntegrations,
      shopName: shops.name,
      registrationNumber: shops.registrationNumber,
      dead: sql<number>`(select count(*) from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.status = 'DEAD')::int`,
      retrying: sql<number>`(select count(*) from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.status = 'FAILED')::int`,
      waiting: sql<number>`(select count(*) from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.status in ('PENDING', 'CLAIMED'))::int`,
    })
    .from(shopIntegrations)
    .innerJoin(shops, eq(shops.id, shopIntegrations.shopId))
    .where(
      and(
        ne(shopIntegrations.status, "DISCONNECTED"),
        query.provider ? eq(shopIntegrations.provider, query.provider) : undefined,
        query.q ? or(ilike(shops.name, `%${query.q}%`), ilike(shops.registrationNumber, `%${query.q}%`)) : undefined,
      ),
    )
    .orderBy(desc(shopIntegrations.lastErrorAt), asc(shops.name))
    .limit(500);
  const now = Date.now();
  const out = rows.map((r) => {
    const adapter = adapterFor(r.integration.provider);
    const online = isConnectorAdapter(adapter)
      ? Boolean(r.integration.connectorSeenAt && now - r.integration.connectorSeenAt.getTime() < CONNECTOR_ONLINE_SECONDS * 1000)
      : null;
    return {
      shopId: r.integration.shopId,
      shopName: r.shopName,
      registrationNumber: r.registrationNumber,
      provider: r.integration.provider,
      label: adapter.label,
      status: r.integration.status,
      connectorOnline: online,
      connectorSeenAt: r.integration.connectorSeenAt,
      lastPullAt: r.integration.lastPullAt,
      lastPushAt: r.integration.lastPushAt,
      lastErrorCode: r.integration.lastErrorCode,
      lastErrorAt: r.integration.lastErrorAt,
      jobs: { dead: r.dead, retrying: r.retrying, waiting: r.waiting },
    };
  });
  if (query.problem === "failed") return out.filter((r) => r.jobs.dead > 0 || r.status === "ERROR");
  if (query.problem === "offline") return out.filter((r) => r.connectorOnline === false);
  if (query.problem === "any") return out.filter((r) => r.jobs.dead > 0 || r.jobs.retrying > 0 || r.status === "ERROR" || r.connectorOnline === false);
  return out;
}

/* --------------------------------------------------------- Zoho sign-in */

/** Signed OAuth state: binds the consent round-trip to this shop, this user and this browser. */
export function signOAuthState(payload: { shopId: string; userId: string; nonce: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", oauthKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyOAuthState(state: string): { shopId: string; userId: string; nonce: string; exp: number } | null {
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", oauthKey()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { shopId: string; userId: string; nonce: string; exp: number };
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function oauthKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return `integration-oauth:${secret}`;
}

/** Requests waiting for the server's dispatcher, started now (after an owner action). */
export function kickDispatch(): void {
  scheduleDispatch();
}
