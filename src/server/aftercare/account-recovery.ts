/**
 * Account recovery request (docs/flows-v3/wave1.md, F18 → F17; flag flow_f17).
 *
 * A person who can no longer use either the mobile number or the e-mail of their account fills in the public form
 * at /account/recover: their name, a contact e-mail and phone they can use now, the old mobile / e-mail of the
 * account, what happened, and a photo or PDF of an identity document. This opens an ACCOUNT ticket for support
 * (system ticket ACCOUNT_RECOVERY) with the document as a staff-only file. Support checks the identity and makes
 * any change to the account through the existing admin screens; nothing is changed automatically.
 *
 * The form answers the same way whether or not an account exists for the details given.
 */
import { randomUUID } from "node:crypto";

import { AppError, validationFailed } from "@/lib/errors";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { addSystemTicketAttachment, checkTicketFile, flowF17On } from "./support-tickets";
import { openSystemTicket } from "./system-tickets";

export interface RecoveryRequestInput {
  name: string;
  contactEmail: string;
  contactPhone?: string | null;
  oldMobile?: string | null;
  oldEmail?: string | null;
  description: string;
}

export interface RecoveryRequestResult {
  ticketNumber: string;
}

function clean(value: string | null | undefined, max: number): string | null {
  const v = (value ?? "").trim();
  return v ? v.slice(0, max) : null;
}

export async function submitRecoveryRequest(input: RecoveryRequestInput, idProof: { name: string; bytes: Buffer }, ip: string | null): Promise<RecoveryRequestResult> {
  if (!(await flowF17On())) throw new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: "flow_f17" });
  const fields: Record<string, string> = {};
  if ((input.name ?? "").trim().length < 2) fields.name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((input.contactEmail ?? "").trim())) fields.contactEmail = "Enter an e-mail address we can reach you at.";
  if (!clean(input.oldMobile, 20) && !clean(input.oldEmail, 200)) fields.oldMobile = "Enter the mobile number or e-mail of the account.";
  if ((input.description ?? "").trim().length < 10) fields.description = "Tell us a little more about what happened.";
  if (!idProof.bytes.length) fields.idProof = "Attach a photo or PDF of an identity document.";
  if (Object.keys(fields).length) throw validationFailed("Please check the highlighted fields.", { fields });
  await checkTicketFile(idProof.bytes);

  const lines = [
    "Account recovery request (lost access to both the mobile number and the e-mail).",
    `Account mobile: ${clean(input.oldMobile, 20) ?? "not given"}`,
    `Account e-mail: ${clean(input.oldEmail, 200) ?? "not given"}`,
    `Contact phone now: ${clean(input.contactPhone, 20) ?? "not given"}`,
    "",
    input.description.trim().slice(0, 3000),
    "",
    "Check the identity document (staff-only file) against the account before changing anything.",
  ];
  const ticket = await openSystemTicket("ACCOUNT_RECOVERY", randomUUID(), {
    subject: `Account recovery: ${input.name.trim().slice(0, 120)}`,
    description: lines.join("\n"),
    priority: "HIGH",
    requesterName: input.name,
    requesterEmail: input.contactEmail,
  });
  if (!ticket) throw new AppError("INTERNAL", "We could not take your request just now. Please try again.");
  await addSystemTicketAttachment(ticket.id, idProof);
  await recordAudit({
    actorId: null,
    actorRole: null,
    action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_REQUESTED,
    entityType: "support_ticket",
    entityId: ticket.id,
    newValue: { ticketNumber: ticket.ticketNumber },
    ipAddress: ip,
  });
  return { ticketNumber: ticket.ticketNumber };
}
