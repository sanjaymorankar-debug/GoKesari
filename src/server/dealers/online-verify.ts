/**
 * Dealer documents checked online (owner, 22-Nov-2026; docs/dealer-programme/ONLINE_VERIFICATION.md).
 *
 * Next to every upload the applicant may instead have the number he typed checked at the source:
 *   - PAN and GSTIN through the KYC provider (KYC_PROVIDER, Sandbox.co.in on both sites), with the name on the
 *     record matched against his legal and representative names (rule sellerVerification.nameMatchAutoApprove);
 *   - the bank account through the bank check (checkDealerBank — Cashfree Bank Account Verification).
 * A document checked this way needs no upload: dealerView reports it VERIFIED_ONLINE, which submit and approval
 * count as accepted. A verified GSTIN also stands in for the address proof (the GST record carries the address).
 *
 * Each check may cost a vendor fee, so it runs only on the saved number, at most 10 times an hour per user, and
 * never again for a number already verified. Outside calls run outside any transaction.
 */
import { and, eq } from "drizzle-orm";

import { decryptSecret } from "@/lib/pan-crypto";
import { conflict, validationFailed } from "@/lib/errors";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { stateCodeFromName } from "@/lib/indian-states";
import type { UserRole } from "@/server/db/schema";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { dealerVerifications, type Dealer } from "@/server/db/schema";
import { verifyDocument } from "@/server/kyc";
import { bankCheckConfig } from "@/server/services/bank-account-check";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

import { checkDealerBank, getDealerForUser } from "./service";

export type OnlineCheckTarget = "PAN" | "GSTIN" | "BANK";

interface Actor {
  id: string;
  role: UserRole;
}

const EDITABLE = ["DRAFT", "REJECTED", "PENDING"];
const LIMIT = { limit: 10, windowMs: 3_600_000 };

/** Whether the bank account can be checked online on this site (the Verification Suite keys are set). */
export function bankCheckAvailable(): boolean {
  return bankCheckConfig() !== null;
}

export interface OnlineCheckResult {
  target: OnlineCheckTarget;
  status: "VERIFIED" | "NAME_MISMATCH" | "FAILED" | "PENDING";
  /** One sentence for the applicant. */
  message: string;
}

/**
 * Checks the applicant's saved PAN, GSTIN or bank account online. Throws when there is nothing to check; never
 * throws for a vendor outage (that is PENDING: "upload the document instead, or try later").
 */
export async function verifyDealerDocumentOnline(actor: Actor, target: OnlineCheckTarget): Promise<OnlineCheckResult> {
  const dealer = await getDealerForUser(actor.id);
  if (!dealer) throw validationFailed("Save your details first.");
  if (!EDITABLE.includes(dealer.status)) throw conflict("Your application is already decided; nothing to check.");
  enforceRateLimit(`dealer-online-check:${actor.id}`, LIMIT);

  if (target === "BANK") return checkBank(dealer, actor);

  const number = target === "PAN" ? (dealer.panEnc ? decryptSecret(dealer.panEnc) : null) : dealer.gstin;
  const numberKey = target === "PAN" ? dealer.panHash : dealer.gstin;
  if (!number || !numberKey) {
    throw validationFailed(target === "PAN" ? "Enter your PAN in step 1 and save first." : "Enter your GSTIN in step 1 and save first.");
  }
  const [previous] = await db.select().from(dealerVerifications).where(and(eq(dealerVerifications.dealerId, dealer.id), eq(dealerVerifications.docType, target)));
  if (previous && previous.numberKey === numberKey && previous.status === "VERIFIED") {
    return { target, status: "VERIFIED", message: `${label(target)} is already verified online.` };
  }

  const stateCode = stateCodeFromName(dealer.state) ?? undefined;
  const result = await verifyDocument(target, number, { nameToMatch: dealer.legalName, ...(stateCode ? { stateCode } : {}) }, `dealer-${dealer.id}-${target}-${numberKey.slice(0, 16)}-${Math.floor(Date.now() / 3_600_000)}`);
  const record = result.record;
  const recordNames = [record?.name, record?.tradeName, record?.ownerName].filter((n): n is string => !!n);
  const score = recordNames.length ? Math.max(...recordNames.flatMap((n) => [nameMatchScore(n, dealer.legalName), nameMatchScore(n, dealer.contactName)])) : null;
  const threshold = (await getRule("sellerVerification")).nameMatchAutoApprove;

  let status: OnlineCheckResult["status"];
  let message: string;
  if (result.status === "VERIFIED") {
    if (score !== null && score >= threshold) {
      status = "VERIFIED";
      message = `${label(target)} verified online${record?.name ? ` (${record.name})` : ""}. No upload needed.`;
    } else {
      status = "NAME_MISMATCH";
      message = `${label(target)} is valid, but the name on it (${record?.name ?? "not given"}) does not match your application. Correct the name in step 1, or upload the document for our team to check.`;
    }
  } else if (result.status === "FAILED" || result.status === "EXPIRED") {
    status = "FAILED";
    message = `${label(target)} could not be verified: ${result.errorCode === "not_found_at_source" ? "the government record has no such number" : "it is not active"}. Check the number, or upload the document.`;
  } else {
    // PENDING (provider down or not set up) or MANUAL_REVIEW (the source gave no clear answer).
    status = "PENDING";
    message = `${label(target)} could not be checked online right now. Upload the document instead, or try again later.`;
  }

  const values = {
    numberKey,
    status,
    matchedName: record?.name ?? null,
    nameScore: score,
    errorCode: result.errorCode,
    provider: result.providerId,
    providerRef: result.rawRef,
    details: { address: record?.address ?? null, stateCode: record?.stateCode ?? null, pincode: record?.pincode ?? null, docStatus: record?.docStatus ?? null },
    checkedBy: actor.id,
    checkedAt: new Date(),
  };
  await db
    .insert(dealerVerifications)
    .values({ dealerId: dealer.id, docType: target, ...values })
    .onConflictDoUpdate({ target: [dealerVerifications.dealerId, dealerVerifications.docType], set: values });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_DOCUMENT_CHECKED_ONLINE,
    entityType: "dealer",
    entityId: dealer.id,
    newValue: { docType: target, status, nameScore: score, provider: result.providerId, providerRef: result.rawRef, errorCode: result.errorCode },
  });
  return { target, status, message };
}

async function checkBank(dealer: Dealer, actor: Actor): Promise<OnlineCheckResult> {
  if (!dealer.bankAccountEnc) throw validationFailed("Enter your bank account in step 1 and save first.");
  if (dealer.bankStatus === "VERIFIED") return { target: "BANK", status: "VERIFIED", message: "Bank account already verified. No upload needed." };
  if (!bankCheckAvailable()) {
    return { target: "BANK", status: "PENDING", message: "The online bank check is not available right now. Upload a cancelled cheque or bank statement instead." };
  }
  const row = await checkDealerBank(dealer.id, actor);
  if (row.bankStatus === "VERIFIED") return { target: "BANK", status: "VERIFIED", message: "Bank account verified with the bank. No upload needed." };
  if (row.bankStatus === "FAILED") return { target: "BANK", status: "FAILED", message: `The bank check failed: ${row.bankStatusReason ?? "the account could not be confirmed"}. Correct it, or upload a cancelled cheque.` };
  return { target: "BANK", status: "PENDING", message: "The bank could not be reached. Upload a cancelled cheque instead, or try again later." };
}

function label(target: "PAN" | "GSTIN"): string {
  return target === "PAN" ? "PAN" : "GSTIN";
}
