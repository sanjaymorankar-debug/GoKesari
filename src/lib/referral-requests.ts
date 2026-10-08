/**
 * "Request a referral code" (docs/four-features-2026-10, feature 4) —
 * client-safe checks shared by the form and the server.
 */
import { parsePhone } from "./phone";
import { SHOP_TYPE_KEYS } from "./shop-types";

export interface ReferralRequestInput {
  name: string;
  mobile: string;
  shopType: string;
  area: string;
  city: string;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
}

export interface CleanReferralRequest {
  name: string;
  mobileE164: string;
  shopType: string;
  area: string;
  city: string;
  pincode: string;
  location: { latitude: number; longitude: number; accuracyM: number | null; mapsUrl: string } | null;
}

const text = (v: string) => v.trim().replace(/\s+/g, " ");

/** Field errors, or the cleaned request. */
export function checkReferralRequest(input: ReferralRequestInput): { ok: true; value: CleanReferralRequest } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const name = text(input.name ?? "");
  if (name.length < 2 || name.length > 80) fields.name = "Enter your name.";
  const phone = parsePhone("+91", input.mobile ?? "");
  if (!phone.ok) fields.mobile = "Enter a valid 10-digit mobile number.";
  if (!(SHOP_TYPE_KEYS as readonly string[]).includes(input.shopType)) fields.shopType = "Choose the type of shop.";
  const area = text(input.area ?? "");
  if (area.length < 2 || area.length > 120) fields.area = "Enter the area or locality.";
  const city = text(input.city ?? "");
  if (city.length < 2 || city.length > 80) fields.city = "Enter the city.";
  const pincode = (input.pincode ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(pincode)) fields.pincode = "A PIN code is 6 digits and does not start with 0.";

  let location: CleanReferralRequest["location"] = null;
  const { latitude, longitude } = input;
  if (latitude != null || longitude != null) {
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      fields.location = "The location could not be read — send without it.";
    } else {
      const lat = Number(latitude.toFixed(6));
      const lng = Number(longitude.toFixed(6));
      location = {
        latitude: lat,
        longitude: lng,
        accuracyM: input.accuracyM != null && Number.isFinite(input.accuracyM) ? Math.round(input.accuracyM) : null,
        mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      };
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { name, mobileE164: phone.ok ? phone.e164 : "", shopType: input.shopType, area, city, pincode, location } };
}

export const REFERRAL_REQUEST_STATUS_LABELS = {
  NEW: "New",
  CODE_ISSUED: "Code issued",
  REJECTED: "Rejected",
} as const;

/** "RCR-1A2B3C4D" — a short reference for the requester and the referrals team. */
export function referralRequestReference(id: string): string {
  return `RCR-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
