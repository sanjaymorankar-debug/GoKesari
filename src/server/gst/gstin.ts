/**
 * GSTIN validation through the GSP (Module 2, Phase 1): the format and check
 * digit are checked locally first (no call for a typo), then the GST
 * system's record — legal and trade name, status, state, taxpayer type —
 * is fetched and kept in gstin_lookups (cache, and the evidence of what the
 * portal said and when). A GSP outage never blocks the owner: the answer says
 * the check is unavailable and the GSTIN is checked again later.
 */
import { and, desc, eq, gte } from "drizzle-orm";

import { gstState, isValidGstin } from "@/lib/gst-states";
import { db } from "@/server/db";
import { gstinLookups } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getGspProvider, GspError } from "./gsp";

const CACHE_HOURS = 24;

export type GstinCheck =
  | { ok: false; reason: "FORMAT"; message: string }
  | { ok: false; reason: "UNAVAILABLE"; message: string }
  | {
      ok: true;
      gstin: string;
      found: boolean;
      active: boolean;
      legalName: string | null;
      tradeName: string | null;
      status: string | null;
      stateCode: string | null;
      stateName: string | null;
      taxpayerType: string | null;
      registrationDate: string | null;
      address: string | null;
      provider: string;
      checkedAt: Date;
      message: string;
    };

export function normaliseGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function describe(found: boolean, status: string | null): string {
  if (!found) return "No GST registration was found for this GSTIN. Check the number.";
  if ((status ?? "").toLowerCase() === "active") return "GSTIN is active.";
  return `This GSTIN is ${status?.toLowerCase() ?? "not active"} on the GST portal.`;
}

export async function checkGstin(raw: string, actor: { id: string } | null, options: { fresh?: boolean } = {}): Promise<GstinCheck> {
  const gstin = normaliseGstin(raw);
  if (!isValidGstin(gstin)) {
    return { ok: false, reason: "FORMAT", message: "This is not a valid GSTIN: it must be 15 characters and its last character must match (check digit)." };
  }
  if (!options.fresh) {
    const [cached] = await db
      .select()
      .from(gstinLookups)
      .where(and(eq(gstinLookups.gstin, gstin), gte(gstinLookups.lookedUpAt, new Date(Date.now() - CACHE_HOURS * 3600_000))))
      .orderBy(desc(gstinLookups.lookedUpAt))
      .limit(1);
    if (cached) return view(cached);
  }
  let provider;
  try {
    provider = getGspProvider();
    const details = await provider.validateGstin(gstin);
    const [row] = await db
      .insert(gstinLookups)
      .values({
        gstin,
        provider: provider.name,
        found: details.found,
        legalName: details.legalName,
        tradeName: details.tradeName,
        status: details.status,
        stateCode: details.stateCode,
        taxpayerType: details.taxpayerType,
        registrationDate: details.registrationDate,
        address: details.address,
        raw: details.raw ?? null,
        lookedUpBy: actor?.id ?? null,
      })
      .returning();
    await recordAudit({
      actorId: actor?.id ?? null,
      action: AUDIT_ACTIONS.GSTIN_LOOKED_UP,
      entityType: "gstin",
      entityId: null,
      newValue: { gstin, found: details.found, status: details.status, provider: provider.name },
    });
    return view(row);
  } catch (error) {
    if (error instanceof GspError) {
      console.warn("[gst] GSTIN check unavailable", error.code, error.message);
      return { ok: false, reason: "UNAVAILABLE", message: "The GST check is not available right now. Your GSTIN is saved and will be checked again." };
    }
    throw error;
  }
}

function view(row: typeof gstinLookups.$inferSelect): GstinCheck {
  const state = gstState(row.stateCode ?? row.gstin);
  return {
    ok: true,
    gstin: row.gstin,
    found: row.found,
    active: row.found && (row.status ?? "").toLowerCase() === "active",
    legalName: row.legalName,
    tradeName: row.tradeName,
    status: row.status,
    stateCode: state?.code ?? row.stateCode,
    stateName: state?.name ?? null,
    taxpayerType: row.taxpayerType,
    registrationDate: row.registrationDate,
    address: row.address,
    provider: row.provider,
    checkedAt: row.lookedUpAt,
    message: describe(row.found, row.status),
  };
}
