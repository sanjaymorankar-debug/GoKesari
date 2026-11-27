/**
 * Pico Xpress answers (docs/pico-xpress-2026-11). Every response is { response, responseCode, responseMessage };
 * success is responseCode "PX_200", whatever the HTTP status. Errors are classified by message text as well as
 * code, because Pico's own sample answers PX_401 for "pincode is not serviceable" (documented as PX_402).
 */

export type PicoErrorKind =
  | "AUTH"
  | "NOT_SERVICEABLE"
  | "INVALID_INPUT"
  | "INVALID_GSTIN"
  | "AWB_NOT_ALLOTTED"
  | "AWB_NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NOT_CANCELLABLE"
  | "UNKNOWN"
  | "NETWORK"
  | "BAD_RESPONSE";

export class PicoError extends Error {
  constructor(
    readonly kind: PicoErrorKind,
    /** Pico's message (never shown raw to customers). */
    readonly picoMessage: string,
    readonly pxCode: string | null,
    readonly httpStatus: number | null,
    /** True only for network failures and 5xx: the only errors that are retried. */
    readonly retryable: boolean,
  ) {
    super(`${pxCode ?? kind}: ${picoMessage}`);
    this.name = "PicoError";
  }

  /** True when Pico did not create the order, so its AWB can go back to the pool. */
  get orderNotCreated(): boolean {
    return ["AUTH", "NOT_SERVICEABLE", "INVALID_INPUT", "INVALID_GSTIN", "AWB_NOT_ALLOTTED", "AWB_NOT_FOUND"].includes(this.kind);
  }

  /** Operations must look at it at once (wrong keys, AWB trouble). */
  get alertsAdmin(): boolean {
    return this.kind === "AUTH" || this.kind === "AWB_NOT_ALLOTTED" || this.kind === "AWB_NOT_FOUND";
  }
}

/** Pure: what kind of failure a non-PX_200 answer is. */
export function classifyPicoError(pxCode: string | null | undefined, message: string | null | undefined): PicoErrorKind {
  const m = (message ?? "").toLowerCase();
  // Message text first: it is more specific than the code (see the PX_401 / serviceable note above).
  if (/already\s+(exists|placed|created|manifest)|duplicate/.test(m)) return "ALREADY_EXISTS";
  if (/not\s+serviceable|unserviceable|non[-\s]?serviceable/.test(m)) return "NOT_SERVICEABLE";
  if (/gstin|gst\s*number|gst\s*no/.test(m)) return "INVALID_GSTIN";
  if (/not\s+(a\s+)?part\s+of\s+allotted|not\s+allotted/.test(m)) return "AWB_NOT_ALLOTTED";
  if (/waybill\s+not\s+found|awb\s+not\s+found/.test(m)) return "AWB_NOT_FOUND";
  if (/cannot\s+be\s+cancel|can\s*not\s+cancel|already\s+picked|not\s+cancellable/.test(m)) return "NOT_CANCELLABLE";
  if (/not\s+authori[sz]ed|not\s+a\s+registered\s+client|invalid\s+(api|client)\s*key|unauthori[sz]ed/.test(m)) return "AUTH";
  // Pico's sample answers PX_402 for "orderId field cannot be empty": input wording wins over the code. Not for
  // PX_501, where Pico itself does not know what happened (the order may exist).
  if (pxCode !== "PX_501" && /cannot\s+be\s+empty|can\s*not\s+be\s+empty|is\s+required|should\s+be|must\s+be|invalid|mismatch/.test(m)) {
    return "INVALID_INPUT";
  }
  switch (pxCode) {
    case "PX_401":
      return "AUTH";
    case "PX_402":
      return "NOT_SERVICEABLE";
    case "PX_403":
      return "INVALID_INPUT";
    case "PX_404":
      return "INVALID_GSTIN";
    case "PX_406":
      return "AWB_NOT_ALLOTTED";
    case "PX_407":
      return "AWB_NOT_FOUND";
    default:
      return "UNKNOWN";
  }
}

/** What the shop owner (or customer) is told. Pico's own text is added only where it helps and is safe. */
export function friendlyPicoMessage(kind: PicoErrorKind, picoMessage = ""): string {
  switch (kind) {
    case "AUTH":
      return "The delivery partner could not be reached right now (account check failed). Our team has been told — please choose pickup or your own delivery for this order.";
    case "NOT_SERVICEABLE":
      return "The gokesari.com delivery partner does not serve this pickup or delivery address right now. Choose pickup or your own delivery.";
    case "INVALID_INPUT":
      return `The delivery partner refused the order details${picoMessage ? `: ${picoMessage.slice(0, 160)}` : ""}. Check the shop and customer details, or choose another delivery option.`;
    case "INVALID_GSTIN":
      return "The delivery partner did not accept the shop's GSTIN. Check the GSTIN in My Shop → Business details, or choose another delivery option.";
    case "AWB_NOT_ALLOTTED":
    case "AWB_NOT_FOUND":
      return "The delivery partner could not use the tracking number for this order. Our team has been told — please try again in a few minutes or choose another delivery option.";
    case "ALREADY_EXISTS":
      return "This order is already booked with the delivery partner.";
    case "NOT_CANCELLABLE":
      return "The delivery partner can no longer cancel this shipment (the rider may have picked it up). Raise a return or a dispute instead.";
    case "NETWORK":
      return "The delivery partner did not answer in time. Please try again in a minute.";
    case "BAD_RESPONSE":
    case "UNKNOWN":
    default:
      return "The delivery partner could not take this order right now. Please try again, or choose pickup or your own delivery.";
  }
}
