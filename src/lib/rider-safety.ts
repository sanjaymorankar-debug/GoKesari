/**
 * Rider safety and benefits (Rider App v2): pure helpers shared by the SOS and insurance
 * services, their pages and the unit tests. No database, no server-only imports.
 */

/** A Google Maps link to a position, or null without one (or with a nonsense one). */
export function sosMapUrl(latitude: number | null | undefined, longitude: number | null | undefined): string | null {
  if (latitude == null || longitude == null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return `https://www.google.com/maps?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

/** The {{placeholders}} of the RIDER_SOS_RAISED notice that goes to operations. */
export function buildSosAlertVars(input: {
  riderName: string;
  mobile: string;
  orderNumber?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): { riderName: string; mobile: string; orderPart: string; mapUrl: string } {
  return {
    riderName: input.riderName.trim() || "A rider",
    mobile: input.mobile.trim() || "no number",
    orderPart: input.orderNumber ? ` during order ${input.orderNumber}` : "",
    mapUrl: sosMapUrl(input.latitude, input.longitude) ?? "not shared (ask the rider)",
  };
}

/* ---------------------------------------------------------------- insurance */

export interface InsuranceEligibilityInput {
  isActive: boolean;
  validFrom: string;
  validTo: string;
  minDeliveries: number;
  /** DELIVERED deliveries the rider completed in the policy's look-back window. */
  deliveredInWindow: number;
  /** Today's date in IST, "YYYY-MM-DD". */
  today: string;
}

export interface InsuranceEligibility {
  active: boolean;
  withinDates: boolean;
  enoughDeliveries: boolean;
  deliveriesShort: number;
}

/**
 * A rider is covered (Active) when the policy is active, today lies within its valid dates
 * (both ends included) and they completed at least minDeliveries in the look-back window.
 */
export function insuranceEligibility(input: InsuranceEligibilityInput): InsuranceEligibility {
  const withinDates = input.validFrom <= input.today && input.today <= input.validTo;
  const needed = Math.max(0, Math.floor(input.minDeliveries));
  const enoughDeliveries = input.deliveredInWindow >= needed;
  return {
    active: input.isActive && withinDates && enoughDeliveries,
    withinDates,
    enoughDeliveries,
    deliveriesShort: Math.max(0, needed - input.deliveredInWindow),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (value: string) => DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Field errors for a nominee (empty object = fine). Mobile is optional; date of birth must not be in the future. */
export function nomineeErrors(
  input: { name: string; relation: string; mobile?: string | null; dateOfBirth?: string | null },
  today: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) errors.name = "Enter the nominee's full name.";
  const relation = input.relation.trim();
  if (relation.length < 2 || relation.length > 40) errors.relation = "Enter how the nominee is related to you.";
  const mobile = input.mobile?.trim();
  if (mobile && !/^[6-9]\d{9}$/.test(mobile)) errors.mobile = "Enter a valid 10-digit mobile number.";
  const dob = input.dateOfBirth?.trim();
  if (dob) {
    if (!isIsoDate(dob)) errors.dateOfBirth = "Enter a valid date of birth.";
    else if (dob > today) errors.dateOfBirth = "Date of birth cannot be in the future.";
  }
  return errors;
}

/** Field errors for an emergency contact (all three are needed; it must not be the rider's own number). */
export function emergencyContactErrors(
  input: { name: string; mobile: string; relation?: string | null },
  ownMobile: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) errors.name = "Enter your emergency contact's name.";
  const mobile = input.mobile.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) errors.mobile = "Enter your emergency contact's 10-digit mobile number.";
  else if (mobile === ownMobile.trim()) errors.mobile = "Your emergency contact needs a different mobile number from yours.";
  if ((input.relation ?? "").trim().length > 40) errors.relation = "Keep the relation under 40 characters.";
  return errors;
}
