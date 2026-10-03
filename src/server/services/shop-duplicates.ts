/**
 * Duplicate shop-registration guard.
 *
 * Before a shop is registered — or a PAN is added to one — this looks for the
 * same shop already on the platform:
 *
 *   - Shop Act / Gumasta licence: a match always means the same shop, since a
 *     licence covers exactly one establishment.
 *   - PAN or Udyam number: shared by every branch of one owner or enterprise,
 *     so a match counts only when it is also the same place — same PIN code
 *     and the same shop name or first address line.
 *   - The same account registering the same shop name at the same PIN code —
 *     catches repeat submissions for shops registered before these numbers
 *     were collected.
 *
 * A match that is PENDING_APPROVAL, APPROVED, SUSPENDED or INACTIVE blocks the
 * submission. A REJECTED match from the same account is reused: the caller
 * updates that row and sends it back for review instead of inserting a new
 * one. A REJECTED match from a different account is ignored, so an impostor's
 * rejected attempt neither blocks the real owner nor hands them its record.
 *
 * Race safety: callers take lockRegistrationKeys() inside their transaction
 * before findRegistrationMatches(), so two simultaneous submissions of the
 * same shop (a double-click, two tabs) run one after the other and the second
 * sees the first. The partial unique index on shops.shop_act_key is the
 * database's own backstop for any write that skips the lock.
 *
 * Messages reveal nothing about the matched shop beyond its review status,
 * and echo identifiers masked — only ever the applicant's own input, which
 * by definition is what matched.
 */
import { createHash } from "node:crypto";

import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { conflict, type AppError, validationFailed, violatedUniqueIndex } from "@/lib/errors";
import {
  decryptPan,
  encryptPan,
  maskPan,
  panBlindIndex,
} from "@/lib/pan-crypto";
import {
  looseKey,
  maskTail,
  parsePanNumber,
  parseShopActNumber,
  parseUdyamNumber,
  type ShopActNumber,
} from "@/lib/shop-identity";
import { db, type DbClient } from "@/server/db";
import {
  shops,
  type Shop,
  type ShopStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

export type DuplicateMatchReason =
  | "SHOP_ACT"
  | "PAN"
  | "UDYAM"
  | "NAME_AND_PIN";

/** Parsed, normalised identifiers. The PAN carries its blind index, never stored plain. */
export interface ShopIdentity {
  shopAct: ShopActNumber | null;
  pan: { normalized: string; hash: string; last4: string } | null;
  udyamNumber: string | null;
}

export interface ShopIdentifierInput {
  shopActNumber?: string | null;
  panNumber?: string | null;
  udyamNumber?: string | null;
}

/** A shop about to be registered, or an existing shop about to gain a PAN. */
export interface RegistrationCandidate {
  ownerId: string;
  name: string;
  addressLine1: string;
  pincode: string;
  identity: ShopIdentity;
  /** The shop being edited — never a duplicate of itself. */
  excludeShopId?: string;
  /** Apply the same-account + name + PIN code rule. Default true. */
  sameOwnerRule?: boolean;
}

export interface DuplicateMatch {
  shop: Pick<
    Shop,
    "id" | "ownerId" | "status" | "registrationNumber" | "createdAt"
  >;
  reason: DuplicateMatchReason;
}

export interface RegistrationMatches {
  /** The strongest live match: the submission must be refused. */
  blocking: DuplicateMatch | null;
  /** The same account's latest REJECTED registration of this shop: update it instead of inserting. */
  rejectedOwn: DuplicateMatch | null;
}

/* ------------------------------------------------------------ parsing */

/**
 * Validates and normalises whichever identifiers were supplied, throwing one
 * VALIDATION_FAILED that names every invalid field. The PAN is hashed here;
 * shopIdentityColumns() encrypts it for storage.
 */
export function parseShopIdentifiers(input: ShopIdentifierInput): ShopIdentity {
  const fields: Record<string, string> = {};
  const identity: ShopIdentity = {
    shopAct: null,
    pan: null,
    udyamNumber: null,
  };

  if (input.shopActNumber?.trim()) {
    const parsed = parseShopActNumber(input.shopActNumber);
    if (parsed.ok) identity.shopAct = parsed.value;
    else fields.shopActNumber = parsed.error;
  }
  if (input.panNumber?.trim()) {
    const parsed = parsePanNumber(input.panNumber);
    if (parsed.ok) {
      identity.pan = {
        normalized: parsed.value,
        hash: panBlindIndex(parsed.value),
        last4: parsed.value.slice(-4),
      };
    } else {
      fields.panNumber = parsed.error;
    }
  }
  if (input.udyamNumber?.trim()) {
    const parsed = parseUdyamNumber(input.udyamNumber);
    if (parsed.ok) identity.udyamNumber = parsed.value;
    else fields.udyamNumber = parsed.error;
  }

  if (Object.keys(fields).length > 0) {
    throw validationFailed("Please check the highlighted fields.", { fields });
  }
  return identity;
}

/**
 * The shops columns for whichever identifiers were supplied. Absent ones are
 * left out, so a resubmission never erases a number already on file. A PAN is
 * stored exactly as the /shop PAN form stores it — encrypted, last four
 * characters for masked display, self-declared until an admin checks it in
 * the GST/PAN verification queue.
 */
export function shopIdentityColumns(
  identity: ShopIdentity,
  panHolderName: string,
): Partial<typeof shops.$inferInsert> {
  return {
    ...(identity.shopAct
      ? {
          shopActNumber: identity.shopAct.display,
          shopActKey: identity.shopAct.key,
        }
      : {}),
    ...(identity.udyamNumber ? { udyamNumber: identity.udyamNumber } : {}),
    ...(identity.pan
      ? {
          panNumberEncrypted: encryptPan(identity.pan.normalized),
          panLast4: identity.pan.last4,
          panHash: identity.pan.hash,
          panHolderName,
          panStatus: "PENDING_VERIFICATION" as const,
          panVerificationSource: "SELF_DECLARED" as const,
          panVerifiedAt: null,
          panVerifiedBy: null,
        }
      : {}),
  };
}

/* ------------------------------------------------------------ locking */

function lockLabels(candidate: RegistrationCandidate): string[] {
  const { shopAct, pan, udyamNumber } = candidate.identity;
  const labels: string[] = [];
  if (shopAct) labels.push(`shop-act:${shopAct.key}`);
  if (pan) labels.push(`pan:${pan.hash}`);
  if (udyamNumber) labels.push(`udyam:${udyamNumber}`);
  if (candidate.sameOwnerRule !== false) {
    labels.push(
      `owner-shop:${candidate.ownerId}:${candidate.pincode}:${looseKey(candidate.name)}`,
    );
  }
  return labels;
}

/** A bounded, stable key for the label — the primary key of registration_locks. */
function advisoryLockKey(label: string): string {
  return createHash("sha256")
    .update(`shop-registration:${label}`)
    .digest("hex");
}

/**
 * Serialises concurrent registrations of the same shop: one transaction-scoped
 * advisory lock per identifier (and per owner + name + PIN code), taken in a
 * fixed order so two transactions sharing several keys cannot deadlock.
 * Released automatically at commit or rollback. Must run inside a
 * transaction — outside one, each lock is released as soon as it is taken.
 *
 * On MySQL the lock is a row in `registration_locks` rather than
 * pg_advisory_xact_lock; see that table for why not GET_LOCK.
 */
export async function lockRegistrationKeys(
  tx: DbClient,
  candidate: RegistrationCandidate,
): Promise<void> {
  const keys = [...new Set(lockLabels(candidate).map(advisoryLockKey))].sort();
  for (const key of keys) {
    // The row has to exist before it can be locked. Both statements take an
    // exclusive lock on it, held until this transaction ends.
    await tx.execute(
      sql`INSERT INTO registration_locks (name) VALUES (${key})
          ON DUPLICATE KEY UPDATE name = name`,
    );
    await tx.execute(
      sql`SELECT name FROM registration_locks WHERE name = ${key} FOR UPDATE`,
    );
  }
}

/* ----------------------------------------------------------- matching */

const REASON_ORDER: readonly DuplicateMatchReason[] = [
  "SHOP_ACT",
  "PAN",
  "UDYAM",
  "NAME_AND_PIN",
];
const BLOCKING_STATUS_ORDER: readonly ShopStatus[] = [
  "APPROVED",
  "PENDING_APPROVAL",
  "SUSPENDED",
  "INACTIVE",
];

/** Finds existing shops that are the candidate under the rules at the top of this file. */
export async function findRegistrationMatches(
  client: DbClient,
  candidate: RegistrationCandidate,
): Promise<RegistrationMatches> {
  const { shopAct, pan, udyamNumber } = candidate.identity;
  const nameKey = looseKey(candidate.name);
  const addressKey = looseKey(candidate.addressLine1);
  const sameOwnerRule = candidate.sameOwnerRule !== false && nameKey !== "";

  const lookups: SQL[] = [];
  if (shopAct) lookups.push(eq(shops.shopActKey, shopAct.key));
  if (pan) lookups.push(eq(shops.panHash, pan.hash));
  if (udyamNumber) lookups.push(eq(shops.udyamNumber, udyamNumber));
  if (sameOwnerRule) {
    const ownShopsHere = and(
      eq(shops.ownerId, candidate.ownerId),
      eq(shops.pincode, candidate.pincode),
    );
    if (ownShopsHere) lookups.push(ownShopsHere);
  }
  if (lookups.length === 0) return { blocking: null, rejectedOwn: null };

  const rows = await client
    .select({
      id: shops.id,
      ownerId: shops.ownerId,
      status: shops.status,
      registrationNumber: shops.registrationNumber,
      createdAt: shops.createdAt,
      name: shops.name,
      addressLine1: shops.addressLine1,
      pincode: shops.pincode,
      shopActKey: shops.shopActKey,
      panHash: shops.panHash,
      udyamNumber: shops.udyamNumber,
    })
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        or(...lookups),
        candidate.excludeShopId
          ? ne(shops.id, candidate.excludeShopId)
          : undefined,
      ),
    );

  const matches: DuplicateMatch[] = [];
  for (const row of rows) {
    const sameName = nameKey !== "" && looseKey(row.name) === nameKey;
    const samePlace =
      row.pincode === candidate.pincode &&
      (sameName ||
        (addressKey !== "" && looseKey(row.addressLine1) === addressKey));

    let reason: DuplicateMatchReason | null = null;
    if (shopAct && row.shopActKey === shopAct.key) reason = "SHOP_ACT";
    else if (pan && row.panHash === pan.hash && samePlace) reason = "PAN";
    else if (udyamNumber && row.udyamNumber === udyamNumber && samePlace)
      reason = "UDYAM";
    else if (
      sameOwnerRule &&
      row.ownerId === candidate.ownerId &&
      row.pincode === candidate.pincode &&
      sameName
    ) {
      reason = "NAME_AND_PIN";
    }

    if (reason) {
      matches.push({
        reason,
        shop: {
          id: row.id,
          ownerId: row.ownerId,
          status: row.status,
          registrationNumber: row.registrationNumber,
          createdAt: row.createdAt,
        },
      });
    }
  }

  const blocking =
    matches
      .filter((m) => m.shop.status !== "REJECTED")
      .sort(
        (a, b) =>
          REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
          BLOCKING_STATUS_ORDER.indexOf(a.shop.status) -
            BLOCKING_STATUS_ORDER.indexOf(b.shop.status),
      )[0] ?? null;
  const rejectedOwn =
    matches
      .filter(
        (m) =>
          m.shop.status === "REJECTED" && m.shop.ownerId === candidate.ownerId,
      )
      .sort(
        (a, b) => b.shop.createdAt.getTime() - a.shop.createdAt.getTime(),
      )[0] ?? null;

  return { blocking, rejectedOwn };
}

/* ----------------------------------------------------------- messages */

const STATUS_MESSAGES: Record<Exclude<ShopStatus, "REJECTED">, string> = {
  PENDING_APPROVAL:
    "This shop is already registered and is waiting for admin approval. You'll be notified once it's reviewed. You don't need to submit again.",
  APPROVED:
    "This shop is already registered and live on GoKesari. If you're the owner and need to update details, log in to your account or contact support.",
  SUSPENDED:
    "This shop is already registered on GoKesari but isn't active at the moment. Please contact support — you don't need to register it again.",
  INACTIVE:
    "This shop is already registered on GoKesari but isn't active at the moment. Please contact support — you don't need to register it again.",
};

export const RESUBMISSION_MESSAGE =
  "We found your earlier registration of this shop that wasn't approved. Submitting will update it and send it for review again — no new registration is created.";

/** The registration-form field a match is reported against. */
const REASON_FIELDS: Record<DuplicateMatchReason, string> = {
  SHOP_ACT: "shopActNumber",
  PAN: "panNumber",
  UDYAM: "udyamNumber",
  NAME_AND_PIN: "name",
};

/** e.g. "PAN number already registered (XXXXXX234F)". */
function matchedFieldLine(
  reason: DuplicateMatchReason,
  identity: ShopIdentity,
): string {
  switch (reason) {
    case "SHOP_ACT":
      return `Shop Act licence number already registered (ending ${identity.shopAct?.key.slice(-4) ?? ""})`;
    case "PAN":
      return `PAN number already registered (${maskPan(identity.pan?.last4 ?? "")})`;
    case "UDYAM":
      return `Udyam number already registered (ending ${identity.udyamNumber?.slice(-4) ?? ""})`;
    case "NAME_AND_PIN":
      return "You have already registered a shop with this name at this PIN code";
  }
}

/**
 * The 409 for a refused submission: which identifier matched (masked), what
 * state the existing registration is in, and the field to highlight. Staff —
 * who can open any shop anyway — also get the matched shop's id and number.
 */
export function duplicateShopError(
  match: DuplicateMatch,
  identity: ShopIdentity,
  options: {
    privileged?: boolean;
    context?: "registration" | "pan_submission";
  } = {},
): AppError {
  const status = match.shop.status as Exclude<ShopStatus, "REJECTED">;
  const fieldLine = matchedFieldLine(match.reason, identity);
  const message =
    options.context === "pan_submission"
      ? `${fieldLine} for another shop at this address. If both are the same shop, please contact support so the duplicate can be removed.`
      : `${fieldLine}. ${STATUS_MESSAGES[status]}`;

  return conflict(message, {
    reason: "DUPLICATE_SHOP",
    matchedOn: match.reason,
    shopStatus: status,
    fields: { [REASON_FIELDS[match.reason]]: fieldLine },
    ...(options.privileged
      ? {
          matchedShopId: match.shop.id,
          matchedRegistrationNumber: match.shop.registrationNumber,
        }
      : {}),
  });
}

/** Masked identifiers for audit rows — enough to recognise, never enough to reuse. */
export function maskedIdentifiers(identity: ShopIdentity) {
  return {
    shopAct: identity.shopAct ? maskTail(identity.shopAct.key) : null,
    pan: identity.pan ? maskPan(identity.pan.last4) : null,
    udyam: identity.udyamNumber ? maskTail(identity.udyamNumber) : null,
  };
}

/** Audit trail of a refused duplicate, on the shop that already holds the registration. */
export async function recordDuplicateBlocked(
  match: DuplicateMatch,
  identity: ShopIdentity,
  actor: { id: string; role: UserRole },
  context: { kind: "registration" | "pan_submission"; ownerId: string },
): Promise<void> {
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_DUPLICATE_BLOCKED,
    entityType: "shop",
    entityId: match.shop.id,
    newValue: {
      context: context.kind,
      matchedOn: match.reason,
      matchedStatus: match.shop.status,
      attemptedForOwnerId: context.ownerId,
      identifiers: maskedIdentifiers(identity),
    },
  });
}

const SHOP_ACT_UNIQUE_INDEX = "shops_shop_act_key_active_unique";

/**
 * True when a write hit shops_shop_act_key_active_unique — it would have left
 * two live registrations holding one Shop Act licence.
 *
 * On MySQL the index is backed by the generated column `shop_act_active_key`,
 * which is the Shop Act key only while the shop is live, so the index name is
 * what identifies this particular violation (see lib/errors.ts).
 */
export function isShopActUniqueViolation(error: unknown): boolean {
  return violatedUniqueIndex(error) === SHOP_ACT_UNIQUE_INDEX;
}

/* ------------------------------------------------ registration pre-check */

export type DuplicateCheckResult =
  | { status: "CLEAR" }
  | {
      status: "DUPLICATE";
      matchedOn: DuplicateMatchReason;
      /** The form field to highlight, and the short line to show under it. */
      field: string;
      fieldMessage: string;
      shopStatus: ShopStatus;
      message: string;
    }
  | { status: "RESUBMISSION"; message: string };

/**
 * Advisory pre-check for the registration form (POST
 * /api/shops/duplicate-check): the same rules as registerShop(), without the
 * lock — registerShop() checks again, under the lock, on submit. A PAN or
 * Udyam match only counts once the name and PIN code are known, exactly as at
 * registration.
 */
export async function checkRegistrationDuplicate(
  input: ShopIdentifierInput & {
    name?: string | null;
    addressLine1?: string | null;
    pincode?: string | null;
  },
  actor: { id: string },
): Promise<DuplicateCheckResult> {
  const identity = parseShopIdentifiers(input);
  const name = input.name?.trim() ?? "";
  const pincode = input.pincode?.trim() ?? "";

  const { blocking, rejectedOwn } = await findRegistrationMatches(db, {
    ownerId: actor.id,
    name,
    addressLine1: input.addressLine1?.trim() ?? "",
    pincode,
    identity,
    sameOwnerRule: name !== "" && pincode !== "",
  });

  if (blocking) {
    return {
      status: "DUPLICATE",
      matchedOn: blocking.reason,
      field: REASON_FIELDS[blocking.reason],
      fieldMessage: matchedFieldLine(blocking.reason, identity),
      shopStatus: blocking.shop.status,
      message: duplicateShopError(blocking, identity).message,
    };
  }
  if (rejectedOwn)
    return { status: "RESUBMISSION", message: RESUBMISSION_MESSAGE };
  return { status: "CLEAR" };
}

/* --------------------------------------------------------- backfill */

export interface PanHashBackfillResult {
  dryRun: boolean;
  shopsWithPan: number;
  alreadyHashed: number;
  /** Hashed now — or, on a dry run, would be. */
  hashed: number;
  /** Did not decrypt, or decrypted to something that is not a PAN — usually the wrong PAN_ENCRYPTION_KEY. */
  unreadable: number;
}

/**
 * Fills shops.pan_hash for PANs submitted before the column existed, so the
 * duplicate check and scripts/shop-duplicate-report.sql can see them. Each
 * PAN is decrypted in memory only; nothing but counts is logged or returned.
 * Idempotent. Leaves updated_at alone — this is bookkeeping, not an edit.
 */
export async function backfillShopPanHashes(options: {
  apply: boolean;
}): Promise<PanHashBackfillResult> {
  const rows = await db
    .select({
      id: shops.id,
      encrypted: shops.panNumberEncrypted,
      panHash: shops.panHash,
    })
    .from(shops)
    .where(isNotNull(shops.panNumberEncrypted));

  const result: PanHashBackfillResult = {
    dryRun: !options.apply,
    shopsWithPan: rows.length,
    alreadyHashed: 0,
    hashed: 0,
    unreadable: 0,
  };

  for (const row of rows) {
    let hash: string;
    try {
      const parsed = parsePanNumber(decryptPan(row.encrypted ?? ""));
      if (!parsed.ok) {
        result.unreadable += 1;
        continue;
      }
      hash = panBlindIndex(parsed.value);
    } catch {
      result.unreadable += 1;
      continue;
    }

    if (row.panHash === hash) {
      result.alreadyHashed += 1;
      continue;
    }
    if (options.apply) {
      await db.update(shops).set({ panHash: hash }).where(eq(shops.id, row.id));
    }
    result.hashed += 1;
  }
  return result;
}
