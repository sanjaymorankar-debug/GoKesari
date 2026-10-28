/**
 * Dealer and employee referral codes (docs/dealer-programme, GKS-DR-003/004).
 *
 *   dealer    GKS-<state>-<district short code>-<6>   e.g. GKS-MH-PUN-7K4Q9X, GKS-KA-BLR-3H8W2C
 *             GKS-<state>-<6>  while the dealer's state has no district yet  e.g. GKS-TN-5R7K2P
 *   employee  GKS-FE-<6>                                   e.g. GKS-FE-8P2M5N
 *
 * The random part comes from crypto.randomInt over an alphabet without
 * 0/O and 1/I/L. Every code is a row of `referral_codes` — the table the shop
 * registration forms already validate against, with its unique index — plus a
 * `dealer_codes` row saying whose it is. Uniqueness is the database's: a
 * collision is retried with a fresh code. The visible parts of a code mean
 * nothing for authorisation; only the server-side status does.
 *
 * Status is kept in step: a dealer_codes row that is not ACTIVE has its
 * referral_codes row INACTIVE, so a suspended dealer's or a deactivated
 * employee's code is refused by the existing checks (resolveUsableCode) with no
 * change to them. Codes carry no personal data.
 */
import { randomInt } from "node:crypto";

import QRCode from "qrcode";
import { and, eq, inArray } from "drizzle-orm";

import {
  DEALER_CODE_ALPHABET,
  DEALER_CODE_RANDOM_LENGTH,
  type DealerCodeKind,
  type DealerCodeStatus,
} from "@/lib/dealers";
import { conflict, notFound } from "@/lib/errors";
import { db, isSerializationFailure, type DbClient } from "@/server/db";
import { isUniqueViolation } from "@/server/db/split/upsert";
import { dealerCodes, referralCodes, type DealerCode, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

interface Actor {
  id: string;
  role: UserRole;
}

const CODE_ATTEMPTS = 8;

export function randomCodePart(length = DEALER_CODE_RANDOM_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += DEALER_CODE_ALPHABET[randomInt(0, DEALER_CODE_ALPHABET.length)];
  return out;
}

/** A new dealer code for a state (two letters) and, when known, a district short code. */
export function dealerCodeFor(stateCode: string, districtShortCode?: string | null): string {
  const parts = ["GKS", stateCode.toUpperCase(), ...(districtShortCode ? [districtShortCode.toUpperCase()] : []), randomCodePart()];
  return parts.join("-");
}

export function salespersonCode(): string {
  return `GKS-FE-${randomCodePart()}`;
}

/**
 * Creates a new ACTIVE code (referral_codes + dealer_codes) inside `tx`,
 * retrying on a collision. The referral_codes insert runs in a savepoint so a
 * collision does not abort the caller's transaction; a serialization failure is
 * passed up so the whole transaction re-runs (split layout).
 */
export async function issueCode(
  tx: DbClient,
  input: {
    dealerId: string;
    salespersonId?: string | null;
    kind: Exclude<DealerCodeKind, "LEGACY">;
    makeCode: () => string;
    label: string;
    referrerName?: string | null;
    referrerUserId?: string | null;
  },
  actor: Actor,
): Promise<{ code: string; dealerCode: DealerCode }> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = input.makeCode();
    let referralCodeId: string | null = null;
    try {
      referralCodeId = await tx.transaction(async (sp) => {
        const [row] = await sp
          .insert(referralCodes)
          .values({
            code,
            label: input.label,
            referrerName: input.referrerName ?? null,
            referrerUserId: input.referrerUserId ?? null,
            status: "ACTIVE",
            createdBy: actor.id,
          })
          .returning({ id: referralCodes.id });
        return row.id;
      });
    } catch (error) {
      if (isSerializationFailure(error)) throw error;
      if (isUniqueViolation(error) || /referral_codes_code_unique/.test(String((error as Error)?.message ?? ""))) continue;
      throw error;
    }
    const [dealerCode] = await tx
      .insert(dealerCodes)
      .values({
        referralCodeId,
        dealerId: input.dealerId,
        salespersonId: input.salespersonId ?? null,
        kind: input.kind,
        status: "ACTIVE",
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_CODE_ISSUED,
        entityType: "dealer",
        entityId: input.dealerId,
        newValue: { code, kind: input.kind, salespersonId: input.salespersonId ?? null },
      },
      tx,
    );
    return { code, dealerCode };
  }
  throw conflict("Could not generate a unique code. Please try again.");
}

/**
 * Moves codes to a new status and keeps their referral_codes rows in step
 * (ACTIVE ↔ ACTIVE, anything else → INACTIVE). Only codes currently in one of
 * `from` change, so a code retired earlier is never woken up.
 */
export async function setCodesStatus(
  tx: DbClient,
  codeIds: string[],
  from: readonly DealerCodeStatus[],
  to: DealerCodeStatus,
  actor: Actor,
  reason: string,
): Promise<DealerCode[]> {
  if (codeIds.length === 0) return [];
  const changed = await tx
    .update(dealerCodes)
    .set({ status: to, updatedAt: new Date() })
    .where(and(inArray(dealerCodes.id, codeIds), inArray(dealerCodes.status, [...from])))
    .returning();
  if (changed.length === 0) return [];
  await tx
    .update(referralCodes)
    .set({ status: to === "ACTIVE" ? "ACTIVE" : "INACTIVE", updatedAt: new Date() })
    .where(inArray(referralCodes.id, changed.map((c) => c.referralCodeId)));
  for (const c of changed) {
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_CODE_STATUS_CHANGED,
        entityType: "dealer_code",
        entityId: c.id,
        previousValue: { status: from },
        newValue: { status: to, dealerId: c.dealerId, salespersonId: c.salespersonId, reason },
      },
      tx,
    );
  }
  return changed;
}

/** A dealer's codes with their code strings, newest first. */
export async function listDealerCodes(dealerId: string, client: DbClient = db) {
  return client
    .select({
      id: dealerCodes.id,
      code: referralCodes.code,
      kind: dealerCodes.kind,
      status: dealerCodes.status,
      salespersonId: dealerCodes.salespersonId,
      replacedById: dealerCodes.replacedById,
      createdAt: dealerCodes.createdAt,
      referralCodeId: dealerCodes.referralCodeId,
    })
    .from(dealerCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId))
    .where(eq(dealerCodes.dealerId, dealerId))
    .orderBy(dealerCodes.createdAt);
}

/** The code a dealer or employee shares now (ACTIVE, newest), or null. */
export async function activeCodeFor(dealerId: string, salespersonId: string | null, client: DbClient = db): Promise<string | null> {
  const codes = await listDealerCodes(dealerId, client);
  const mine = codes.filter((c) => c.status === "ACTIVE" && (salespersonId ? c.salespersonId === salespersonId : c.kind !== "SALESPERSON"));
  return mine.length ? mine[mine.length - 1].code : null;
}

/**
 * Replaces one code: the old one becomes REPLACED (refused for new
 * registrations; shops already registered with it stay attributed — their
 * redemptions point at the old referral code, which still belongs to the same
 * dealer) and a new code of the same kind is issued. ADMIN only (route + caller).
 */
export async function replaceCode(
  tx: DbClient,
  dealerCodeId: string,
  makeCode: () => string,
  label: string,
  actor: Actor,
  reason: string,
): Promise<{ oldCode: string; newCode: string }> {
  const [old] = await tx
    .select({ dc: dealerCodes, code: referralCodes.code })
    .from(dealerCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId))
    .where(eq(dealerCodes.id, dealerCodeId))
    .for("update");
  if (!old) throw notFound("Code");
  if (old.dc.status !== "ACTIVE" && old.dc.status !== "SUSPENDED") throw conflict("Only an active or suspended code can be replaced.");
  const kind: Exclude<DealerCodeKind, "LEGACY"> = old.dc.salespersonId ? "SALESPERSON" : "DEALER";
  await setCodesStatus(tx, [old.dc.id], ["ACTIVE", "SUSPENDED"], "REPLACED", actor, reason);
  const issued = await issueCode(tx, { dealerId: old.dc.dealerId, salespersonId: old.dc.salespersonId, kind, makeCode, label }, actor);
  // A code replaced while suspended stays suspended under its new string.
  if (old.dc.status === "SUSPENDED") await setCodesStatus(tx, [issued.dealerCode.id], ["ACTIVE"], "SUSPENDED", actor, reason);
  await tx.update(dealerCodes).set({ replacedById: issued.dealerCode.id }).where(eq(dealerCodes.id, old.dc.id));
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DEALER_CODE_REPLACED,
      entityType: "dealer",
      entityId: old.dc.dealerId,
      previousValue: { code: old.code },
      newValue: { code: issued.code, reason },
    },
    tx,
  );
  return { oldCode: old.code, newCode: issued.code };
}

/** The link a code is shared with: Add my shop with the code filled in. */
export function shareLinkFor(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/shop/register?ref=${encodeURIComponent(code)}`;
}

/** WhatsApp share (wa.me with the message only — no phone number). */
export function whatsappShareFor(origin: string, code: string, who: string): string {
  const text = `Register your shop on GoKesari with ${who}'s referral code ${code}: ${shareLinkFor(origin, code)}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export async function codeQrSvg(origin: string, code: string): Promise<string> {
  return QRCode.toString(shareLinkFor(origin, code), { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240 });
}
