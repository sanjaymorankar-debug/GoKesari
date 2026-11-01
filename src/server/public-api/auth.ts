/**
 * GoKesari's public REST API — OAuth2 client credentials (billing v2,
 * docs/billing §8, §10). A shop owner creates a client with the scopes the
 * other software needs; the secret is shown once and only its hash is kept.
 * The software trades id + secret at /api/public/v1/oauth/token for a bearer
 * token valid one hour, bound to that shop and those scopes. Revoking the
 * client ends its tokens at once.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { AppError, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { PUBLIC_API_SCOPES, publicApiClients, publicApiTokens, type PublicApiClient, type PublicApiScope } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled, isFeatureEnabledForShop } from "@/server/services/feature-flags";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN_TTL_SECONDS = 3600;

export async function createApiClient(shopId: string, input: { name: string; scopes: PublicApiScope[] }, actor: { id: string }): Promise<{ client: PublicApiClient; clientSecret: string }> {
  const name = input.name.trim();
  if (name.length < 2) throw validationFailed("Name the software this client is for.");
  const scopes = [...new Set(input.scopes)].filter((s) => (PUBLIC_API_SCOPES as readonly string[]).includes(s));
  if (!scopes.length) throw validationFailed("Choose at least one permission.");
  const clientId = `gkc_${randomBytes(12).toString("hex")}`;
  const clientSecret = `gks_${randomBytes(32).toString("base64url")}`;
  const [client] = await db.insert(publicApiClients).values({ shopId, name, clientId, secretHash: hash(clientSecret), scopes, createdBy: actor.id }).returning();
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.INTEGRATION_TOKEN_ISSUED, entityType: "public_api_client", entityId: client.id, newValue: { shopId, name, scopes } });
  return { client, clientSecret };
}

export async function listApiClients(shopId: string) {
  return db
    .select({ id: publicApiClients.id, name: publicApiClients.name, clientId: publicApiClients.clientId, scopes: publicApiClients.scopes, createdAt: publicApiClients.createdAt, lastUsedAt: publicApiClients.lastUsedAt, revokedAt: publicApiClients.revokedAt })
    .from(publicApiClients)
    .where(eq(publicApiClients.shopId, shopId));
}

export async function revokeApiClient(shopId: string, id: string, actor: { id: string }): Promise<void> {
  const [row] = await db.update(publicApiClients).set({ revokedAt: new Date() }).where(and(eq(publicApiClients.id, id), eq(publicApiClients.shopId, shopId))).returning();
  if (!row) throw notFound("API client");
  await db.delete(publicApiTokens).where(eq(publicApiTokens.clientId, row.id));
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.INTEGRATION_TOKEN_REVOKED, entityType: "public_api_client", entityId: row.id, newValue: { shopId } });
}

const oauthError = (status: number, error: string, description: string) => new AppError(status === 401 ? "UNAUTHENTICATED" : "VALIDATION_FAILED", description, { oauthError: error });

/** grant_type=client_credentials → { access_token, token_type, expires_in, scope }. */
export async function issueToken(input: { grantType: string; clientId: string; clientSecret: string; scope?: string | null }) {
  if (!(await isFeatureEnabled("billing_v2"))) throw new AppError("NOT_FOUND", "This feature is not available.");
  if (input.grantType !== "client_credentials") throw oauthError(400, "unsupported_grant_type", "Only grant_type=client_credentials is supported.");
  const [client] = await db.select().from(publicApiClients).where(and(eq(publicApiClients.clientId, input.clientId), isNull(publicApiClients.revokedAt)));
  const given = Buffer.from(hash(input.clientSecret));
  if (!client || given.length !== client.secretHash.length || !timingSafeEqual(given, Buffer.from(client.secretHash))) throw oauthError(401, "invalid_client", "Unknown client or wrong secret.");
  // QA D-110: the client's shop must be in a district the flag covers.
  if (!(await isFeatureEnabledForShop("billing_v2", client.shopId))) throw new AppError("NOT_FOUND", "This feature is not available.");
  const wanted = input.scope ? input.scope.split(/\s+/).filter(Boolean) : client.scopes;
  if (wanted.some((s) => !client.scopes.includes(s))) throw oauthError(400, "invalid_scope", "The client may not ask for that scope.");
  const token = `gkt_${randomBytes(32).toString("base64url")}`;
  await db.insert(publicApiTokens).values({ clientId: client.id, tokenHash: hash(token), scopes: wanted, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000) });
  await db.update(publicApiClients).set({ lastUsedAt: new Date() }).where(eq(publicApiClients.id, client.id));
  return { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: wanted.join(" ") };
}

export interface ApiCaller {
  shopId: string;
  clientId: string;
  scopes: string[];
}

/** The caller of a public API request, holding `scope`; 401 / 403 otherwise (OAuth2 bearer). */
export async function authenticateApi(request: NextRequest, scope: PublicApiScope): Promise<ApiCaller> {
  if (!(await isFeatureEnabled("billing_v2"))) throw new AppError("NOT_FOUND", "This feature is not available.");
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(gkt_[A-Za-z0-9_-]{20,})$/.exec(header);
  if (!m) throw new AppError("UNAUTHENTICATED", "Send an access token: Authorization: Bearer <token>.");
  const [row] = await db
    .select({ scopes: publicApiTokens.scopes, client: publicApiClients })
    .from(publicApiTokens)
    .innerJoin(publicApiClients, eq(publicApiClients.id, publicApiTokens.clientId))
    .where(and(eq(publicApiTokens.tokenHash, hash(m[1])), gt(publicApiTokens.expiresAt, new Date()), isNull(publicApiClients.revokedAt)));
  if (!row) throw new AppError("UNAUTHENTICATED", "The access token is not valid or has expired.");
  if (!row.scopes.includes(scope)) throw new AppError("FORBIDDEN", `This token lacks the "${scope}" scope.`);
  if (!(await isFeatureEnabledForShop("billing_v2", row.client.shopId))) throw new AppError("NOT_FOUND", "This feature is not available.");
  return { shopId: row.client.shopId, clientId: row.client.clientId, scopes: row.scopes };
}
