/** docs/hdms-2026-11: configure one delivery partner (Super Admin; audited; secrets write-only). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireDeliveryConfig } from "@/server/delivery/access";
import { updateProvider } from "@/server/delivery/admin";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  baseUrl: z.string().max(300).nullable().optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
  reliabilityPercent: z.number().min(0).max(100).optional(),
  maxDistanceKm: z.number().min(0.5).max(200).nullable().optional(),
  maxWeightKg: z.number().min(0.1).max(5000).nullable().optional(),
  refrigerated: z.boolean().optional(),
  credentials: z.record(z.string().min(1).max(60), z.string().max(2000)).nullable().optional(),
  webhookSecret: z.string().max(500).nullable().optional(),
  resetCircuit: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ code: string }>) => {
  const admin = await requireDeliveryConfig();
  const { code } = await context.params;
  const body = await parseBody(request, schema);
  const view = await updateProvider(code.toUpperCase(), body, admin.id);
  // Never the secrets themselves in the audit log: only that they changed.
  const { credentials, webhookSecret, ...rest } = body;
  await recordAudit({
    actorId: admin.id,
    actorRole: admin.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "delivery_provider",
    entityId: view.code,
    newValue: { ...rest, credentialsChanged: credentials !== undefined, webhookSecretChanged: webhookSecret !== undefined },
  });
  return ok(view);
});
