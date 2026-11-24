/**
 * Module 4 (23-Nov-2026, rule deliveryProof.failureReasons): the fixed list of
 * reasons a rider picks from when a drop cannot be completed. Shared by the
 * rider's screen and the server. The stored text (delivery_orders.failure_reason)
 * stays readable on its own: "<label>" or "<label> — <note>"; the code goes in
 * failure_reason_code. Free-text reports (rule off, older apps) keep working.
 */
export const FAILURE_REASON_CODES = [
  "CUSTOMER_NOT_AVAILABLE",
  "WRONG_ADDRESS",
  "REFUSED",
  "PHONE_UNREACHABLE",
  "OTHER",
] as const;

export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

export const FAILURE_REASON_LABELS: Record<FailureReasonCode, string> = {
  CUSTOMER_NOT_AVAILABLE: "Customer not available",
  WRONG_ADDRESS: "Wrong address",
  REFUSED: "Customer refused the order",
  PHONE_UNREACHABLE: "Customer's phone unreachable",
  OTHER: "Other",
};

export const FAILURE_NOTE_MAX = 280;

export type FailureReasonResult = { ok: true; text: string; code: FailureReasonCode | null } | { ok: false; message: string };

/**
 * The reason text and code to store. With a code: its label, plus the note
 * when given ("Other" needs a note of 3+ characters). Without a code: the free
 * text as before (3+ characters).
 */
export function composeFailureReason(code: FailureReasonCode | null | undefined, note: string | null | undefined): FailureReasonResult {
  const trimmed = (note ?? "").trim();
  if (!code) {
    if (trimmed.length < 3) return { ok: false, message: "Say why the delivery could not be completed." };
    return { ok: true, text: trimmed, code: null };
  }
  const shortNote = trimmed.slice(0, FAILURE_NOTE_MAX);
  if (code === "OTHER" && shortNote.length < 3) return { ok: false, message: "Add a short note for \"Other\"." };
  const label = FAILURE_REASON_LABELS[code];
  return { ok: true, text: shortNote ? `${label} — ${shortNote}` : label, code };
}
