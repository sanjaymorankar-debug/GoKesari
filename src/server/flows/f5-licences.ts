/**
 * Flow spec v3, F5 licence reminders (docs/flows-v3/wave3.md, flag flow_f5, rule shopFlowsV3.registrationLicencesToRegister).
 *
 * Owner, 27-Nov-2026: a licence entered, uploaded or scanned at an onboarding v2 registration must count as given
 * everywhere, so the shop is never reminded about it, blocked for it or suspended for it. The documents follow-up
 * already reads registration_licence_entries (0220); the shop's licence register (shop_legal_documents: the owner's
 * Documents page, the legal-documents sweep and order gate, the review queue) did not. So:
 *
 * - copyRegistrationLicences(shopId): every register licence (FSSAI, drug licence, medical registration, the
 *   optional licences and the admin-added ones) given at registration goes into the register — SUBMITTED while
 *   GoKesari's team checks it, APPROVED once verified (online check or the team), REJECTED with the team's reason —
 *   with its number (encrypted, as the register keeps it), expiry, issuing authority and file. Run when the v2 shop
 *   is created, after the team decides the licence, and by the daily follow-up for shops created before (back-fill).
 *   A row is "copied" when its submitted_at is the entry's created_at; a licence the owner sent again from the
 *   Documents page (a later submitted_at) is never overwritten. The seller documents (Shop Act, Udyam) have no
 *   register row: the follow-up and requirementsOnFile count their entries directly.
 * - syncEntryFromRegister(documentId): the team decided the copied row in the legal-documents queue — the
 *   registration entry follows, so the registration-licences queue does not ask again.
 * - markPromisesGiven(shopId): a licence promised at registration ("upload later") and given afterwards is marked
 *   VERIFIED (approved / verified) or keeps PROMISED with a "given, being checked" note — never stale.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { encryptSecret } from "@/lib/pan-crypto";
import { parseLegalDocNumber, type LegalDocKey } from "@/lib/legal-documents";
import { isCustomDocKey } from "@/lib/shop-document-rules";
import { db } from "@/server/db";
import {
  LEGAL_DOC_TYPES,
  registrationLicenceEntries,
  registrationLicenceFiles,
  sellerVerifications,
  shopLegalDocumentFiles,
  shopLegalDocuments,
  type LegalDocType,
  type RegistrationLicenceEntry,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { wave3Switch } from "./wave3-rules";

const COPIED = ["VERIFIED", "PENDING_OPERATOR", "REJECTED"] as const;
const SELLER_GIVEN = new Set(["VERIFIED", "PENDING", "MANUAL_REVIEW"]);

/** Where a registration licence lives in the register: built-in keys by type, admin-added ones as Other licences. */
export function registerSlotOf(licenceKey: string): { docType: LegalDocType; licenceKey: string } | null {
  if (isCustomDocKey(licenceKey)) return { docType: "OTHER_LICENCE", licenceKey };
  if (licenceKey === "OTHER_LICENCE") return null;
  return (LEGAL_DOC_TYPES as readonly string[]).includes(licenceKey) ? { docType: licenceKey as LegalDocType, licenceKey: "" } : null;
}

/** Pure: the register status an entry stands for. */
export function registerStatusOf(entry: Pick<RegistrationLicenceEntry, "status">): "APPROVED" | "SUBMITTED" | "REJECTED" | null {
  if (entry.status === "VERIFIED") return "APPROVED";
  if (entry.status === "PENDING_OPERATOR") return "SUBMITTED";
  if (entry.status === "REJECTED") return "REJECTED";
  return null;
}

const isoDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Copies (or updates the copies of) one shop's registration licences into its register. Returns rows written. */
export async function copyRegistrationLicences(shopId: string): Promise<number> {
  if (!(await wave3Switch("registrationLicencesToRegister"))) return 0;
  const entries = await db
    .select()
    .from(registrationLicenceEntries)
    .where(and(eq(registrationLicenceEntries.shopId, shopId), inArray(registrationLicenceEntries.status, [...COPIED])));
  let written = 0;
  for (const entry of entries) {
    const slot = registerSlotOf(entry.licenceKey);
    const status = registerStatusOf(entry);
    if (!slot || !status) continue;
    const [existing] = await db
      .select()
      .from(shopLegalDocuments)
      .where(and(eq(shopLegalDocuments.shopId, shopId), eq(shopLegalDocuments.docType, slot.docType), eq(shopLegalDocuments.licenceKey, slot.licenceKey)));
    const ours = existing?.submittedAt != null && existing.submittedAt.getTime() === entry.createdAt.getTime();
    // A row the owner (or the sweep's "required" marker) made is replaced only while it holds nothing.
    if (existing && !ours && existing.status !== "NOT_SUBMITTED") continue;
    if (existing && ours && existing.status === status) continue;
    const number = entry.licenceNumber?.trim() || null;
    const parsed = number ? parseLegalDocNumber(slot.docType as LegalDocKey, number) : null;
    const normalized = parsed?.ok ? parsed.normalized : number;
    const now = new Date();
    let customLabel: string | null = null;
    if (slot.docType === "OTHER_LICENCE") {
      const { getShopDocumentType } = await import("@/server/services/shop-document-rules");
      customLabel = (await getShopDocumentType(slot.licenceKey))?.label ?? slot.licenceKey;
    }
    const values = {
      status,
      numberEncrypted: normalized ? encryptSecret(normalized) : null,
      numberLast4: normalized ? normalized.replace(/\s+/g, "").slice(-4) : null,
      issuingCouncil: entry.issuingAuthority,
      licenceName: customLabel,
      expiryDate: isoDate(entry.validUntil),
      submittedAt: entry.createdAt,
      submittedBy: entry.ownerUserId,
      reviewedAt: status === "SUBMITTED" ? null : (entry.reviewedAt ?? entry.verifiedAt ?? now),
      reviewedBy: status === "SUBMITTED" ? null : entry.reviewedBy,
      rejectionReason: status === "REJECTED" ? (entry.statusReason ?? "Rejected by GoKesari's team.") : null,
      updatedAt: now,
    };
    const docId = await db.transaction(async (tx) => {
      let id: string;
      if (existing) {
        await tx.update(shopLegalDocuments).set(values).where(eq(shopLegalDocuments.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await tx
          .insert(shopLegalDocuments)
          .values({ shopId, docType: slot.docType, licenceKey: slot.licenceKey, ...values })
          .onConflictDoNothing()
          .returning({ id: shopLegalDocuments.id });
        if (!row) return null; // written meanwhile by the owner: theirs stands
        id = row.id;
      }
      const hasFile = (await tx.select({ id: shopLegalDocumentFiles.id }).from(shopLegalDocumentFiles).where(eq(shopLegalDocumentFiles.documentId, id)).limit(1)).length > 0;
      if (!hasFile && entry.fileRef) {
        const [file] = await tx.select().from(registrationLicenceFiles).where(eq(registrationLicenceFiles.id, entry.fileRef));
        // Same encryption (encryptBytes) on both tables: the bytes are copied as they are.
        if (file) {
          await tx.insert(shopLegalDocumentFiles).values({
            documentId: id,
            shopId,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            dataEncrypted: file.dataEncrypted,
            uploadedBy: entry.ownerUserId,
            createdAt: file.createdAt,
          });
        }
      }
      await recordAudit(
        {
          actorId: null,
          action: AUDIT_ACTIONS.SHOP_LEGAL_DOCUMENT_SUBMITTED,
          entityType: "shop_legal_document",
          entityId: id,
          previousValue: existing ? { status: existing.status } : null,
          newValue: { shopId, docType: slot.docType, status, fromRegistrationEntry: entry.id, flow: "flow_f5" },
        },
        tx,
      );
      return id;
    });
    if (docId) written += 1;
  }
  if (written > 0) await (await import("@/server/onboarding-v2/document-reactivation")).afterShopDocumentGiven(shopId);
  return written;
}

/** After copyRegistrationLicences fails or for shops created before flow_f5: never throws. */
export async function copyRegistrationLicencesSafely(shopId: string | null | undefined): Promise<void> {
  if (!shopId) return;
  await copyRegistrationLicences(shopId).catch((error: unknown) => console.error("[flows-v3 f5] registration licences not copied (the daily run retries)", shopId, error));
}

/**
 * The team decided a register row in the legal-documents queue: when that row is a registration copy, the entry
 * follows (VERIFIED / REJECTED), so the registration-licences queue does not ask again. Never throws.
 */
export async function syncEntryFromRegister(documentId: string): Promise<void> {
  try {
    if (!(await wave3Switch("registrationLicencesToRegister"))) return;
    const [doc] = await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.id, documentId));
    if (!doc?.submittedAt || (doc.status !== "APPROVED" && doc.status !== "REJECTED")) return;
    const key = doc.docType === "OTHER_LICENCE" ? doc.licenceKey : doc.docType;
    const now = new Date();
    await db
      .update(registrationLicenceEntries)
      .set({
        status: doc.status === "APPROVED" ? "VERIFIED" : "REJECTED",
        statusReason: doc.status === "APPROVED" ? "Checked by GoKesari's team." : doc.rejectionReason,
        verifiedAt: doc.status === "APPROVED" ? now : null,
        reviewedBy: doc.reviewedBy,
        reviewedAt: doc.reviewedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(registrationLicenceEntries.shopId, doc.shopId),
          eq(registrationLicenceEntries.licenceKey, key),
          eq(registrationLicenceEntries.status, "PENDING_OPERATOR"),
          // submitted_at holds the entry's created_at as JavaScript keeps it (milliseconds).
          sql`date_trunc('milliseconds', ${registrationLicenceEntries.createdAt}) = ${doc.submittedAt.toISOString()}::timestamptz`,
        ),
      );
  } catch (error) {
    console.error("[flows-v3 f5] registration entry not synced", documentId, error);
  }
}

/**
 * A licence promised at registration and given afterwards (the register, or a seller document): VERIFIED once it
 * is approved / verified; while it is being checked it stays PROMISED with a note. Returns entries changed.
 */
export async function markPromisesGiven(shopId: string): Promise<number> {
  if (!(await wave3Switch("registrationLicencesToRegister"))) return 0;
  const promised = await db
    .select()
    .from(registrationLicenceEntries)
    .where(and(eq(registrationLicenceEntries.shopId, shopId), eq(registrationLicenceEntries.status, "PROMISED")));
  if (promised.length === 0) return 0;
  const [legal, seller] = await Promise.all([
    db.select({ docType: shopLegalDocuments.docType, licenceKey: shopLegalDocuments.licenceKey, status: shopLegalDocuments.status }).from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shopId)),
    db.select({ docType: sellerVerifications.docType, status: sellerVerifications.status }).from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId)),
  ]);
  const GIVEN_NOTE = "Given after registration; GoKesari's team is checking it.";
  let changed = 0;
  for (const entry of promised) {
    let state: "DONE" | "CHECKING" | null = null;
    const sellerRow = seller.find((s) => s.docType === entry.licenceKey);
    if (sellerRow && SELLER_GIVEN.has(sellerRow.status)) state = sellerRow.status === "VERIFIED" ? "DONE" : "CHECKING";
    const slot = registerSlotOf(entry.licenceKey);
    const legalRow = slot ? legal.find((l) => l.docType === slot.docType && l.licenceKey === slot.licenceKey) : undefined;
    if (legalRow?.status === "APPROVED") state = "DONE";
    else if (legalRow?.status === "SUBMITTED" && state === null) state = "CHECKING";
    if (state === null) continue;
    if (state === "CHECKING" && entry.statusReason === GIVEN_NOTE) continue;
    const now = new Date();
    await db
      .update(registrationLicenceEntries)
      .set(state === "DONE" ? { status: "VERIFIED", statusReason: "Given after registration and checked.", verifiedAt: now, updatedAt: now } : { statusReason: GIVEN_NOTE, updatedAt: now })
      .where(and(eq(registrationLicenceEntries.id, entry.id), eq(registrationLicenceEntries.status, "PROMISED")));
    changed += 1;
  }
  return changed;
}

/**
 * Daily (runShopDocumentFollowUp, before it decides who is chased): copies the registration licences of shops whose
 * register does not show them yet, and marks given promises. Returns counts. No-op with the switch off.
 */
export async function backfillRegistrationLicences(limit = 500): Promise<{ shops: number; copied: number; promisesGiven: number }> {
  if (!(await wave3Switch("registrationLicencesToRegister"))) return { shops: 0, copied: 0, promisesGiven: 0 };
  const rows = await db
    .selectDistinct({ shopId: registrationLicenceEntries.shopId })
    .from(registrationLicenceEntries)
    .where(
      and(
        isNotNull(registrationLicenceEntries.shopId),
        // Shop Act / Udyam have no register row (seller documents): only their promises are looked at.
        sql`(${registrationLicenceEntries.status} = 'PROMISED' OR (${registrationLicenceEntries.licenceKey} NOT IN ('SHOP_ACT', 'UDYAM') AND NOT EXISTS (
          SELECT 1 FROM shop_legal_documents d
          WHERE d.shop_id = ${registrationLicenceEntries.shopId}
            AND d.submitted_at = date_trunc('milliseconds', ${registrationLicenceEntries.createdAt})
            AND d.status = CASE ${registrationLicenceEntries.status} WHEN 'VERIFIED' THEN 'APPROVED' WHEN 'PENDING_OPERATOR' THEN 'SUBMITTED' ELSE 'REJECTED' END)))`,
      ),
    )
    .limit(limit);
  let copied = 0;
  let promisesGiven = 0;
  for (const r of rows) {
    if (!r.shopId) continue;
    try {
      copied += await copyRegistrationLicences(r.shopId);
      promisesGiven += await markPromisesGiven(r.shopId);
    } catch (error) {
      console.error("[flows-v3 f5] back-fill failed", r.shopId, error);
    }
  }
  return { shops: rows.length, copied, promisesGiven };
}
