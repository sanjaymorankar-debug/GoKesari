/**
 * Delivery partner registration details (gig worker flow, feature 1): the
 * checks shared by the registration form and registerDeliveryPartner, so both
 * accept and refuse the same thing. Client-safe.
 */
import { normaliseVehicleRegistration } from "@/lib/kyc/rider-details";

export const RIDER_GENDERS = [
  { key: "FEMALE", label: "Female" },
  { key: "MALE", label: "Male" },
  { key: "OTHER", label: "Other" },
  { key: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
] as const;
export type RiderGender = (typeof RIDER_GENDERS)[number]["key"];
export const RIDER_GENDER_KEYS = RIDER_GENDERS.map((g) => g.key) as [RiderGender, ...RiderGender[]];

export const RIDER_MIN_AGE_YEARS = 18;
/** Vehicles that carry no registration number. */
export const VEHICLES_WITHOUT_NUMBER: readonly string[] = ["BICYCLE"];

export const REGISTRATION_MESSAGES = {
  mobile: "Enter a valid 10-digit Indian mobile number.",
  email: "Enter a valid email address.",
  dateOfBirth: "Enter your date of birth.",
  underAge: `You must be at least ${RIDER_MIN_AGE_YEARS} years old to deliver with GoKesari.`,
  futureDate: "The date of birth can't be in the future.",
  gender: "Select your gender.",
  addressLine: "Enter your house, street and area.",
  addressCity: "Enter your city.",
  addressPincode: "Enter your 6-digit PIN code.",
  vehicleNumber: "Enter your vehicle's registration number.",
  emergencyName: "Enter the name of someone we can call in an emergency.",
  emergencyMobile: "Enter your emergency contact's 10-digit mobile number.",
  emergencySame: "Your emergency contact needs a different mobile number from yours.",
  location: "Share your current location to complete registration. Allow location access for GoKesari, then tap \"Share my location\".",
  duplicateMobile: "A delivery partner is already registered with this mobile number. Sign in with that account, or use another number.",
} as const;

export const isIndianMobile = (value: string) => /^[6-9]\d{9}$/.test(value);
export const isPincode = (value: string) => /^[1-9]\d{5}$/.test(value);
export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

/** Whole years between an ISO date of birth and `today` (YYYY-MM-DD). */
export function ageInYears(dateOfBirth: string, today: string): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

export interface RegistrationDetailsInput {
  mobile: string;
  email?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  addressLine?: string | null;
  addressCity?: string | null;
  addressPincode?: string | null;
  vehicleType: string;
  vehicleRegistrationNumber?: string | null;
  emergencyContactName?: string | null;
  emergencyContactMobile?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type RegistrationField =
  | "email"
  | "dateOfBirth"
  | "gender"
  | "addressLine"
  | "addressCity"
  | "addressPincode"
  | "vehicleRegistrationNumber"
  | "emergencyContactName"
  | "emergencyContactMobile"
  | "location";

const blank = (value: string | null | undefined) => !value?.trim();

/**
 * Field errors for a registration. `required` (the registration form and
 * API) makes every field of the brief mandatory; without it only the format
 * of what was given is checked.
 */
export function checkRegistrationDetails(
  input: RegistrationDetailsInput,
  options: { required: boolean; today: string },
): Partial<Record<RegistrationField, string>> {
  const errors: Partial<Record<RegistrationField, string>> = {};
  const need = (field: RegistrationField, value: string | null | undefined, message: string) => {
    if (options.required && blank(value)) errors[field] = message;
  };

  need("email", input.email, REGISTRATION_MESSAGES.email);
  if (!blank(input.email) && !isEmail(input.email!.trim())) errors.email = REGISTRATION_MESSAGES.email;

  need("dateOfBirth", input.dateOfBirth, REGISTRATION_MESSAGES.dateOfBirth);
  if (!blank(input.dateOfBirth)) {
    const dob = input.dateOfBirth!.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) errors.dateOfBirth = REGISTRATION_MESSAGES.dateOfBirth;
    else if (dob > options.today) errors.dateOfBirth = REGISTRATION_MESSAGES.futureDate;
    else if (ageInYears(dob, options.today) < RIDER_MIN_AGE_YEARS) errors.dateOfBirth = REGISTRATION_MESSAGES.underAge;
  }

  need("gender", input.gender, REGISTRATION_MESSAGES.gender);
  if (!blank(input.gender) && !(RIDER_GENDER_KEYS as readonly string[]).includes(input.gender!)) errors.gender = REGISTRATION_MESSAGES.gender;

  need("addressLine", input.addressLine, REGISTRATION_MESSAGES.addressLine);
  if (!blank(input.addressLine) && input.addressLine!.trim().length < 5) errors.addressLine = REGISTRATION_MESSAGES.addressLine;
  need("addressCity", input.addressCity, REGISTRATION_MESSAGES.addressCity);
  need("addressPincode", input.addressPincode, REGISTRATION_MESSAGES.addressPincode);
  if (!blank(input.addressPincode) && !isPincode(input.addressPincode!.trim())) errors.addressPincode = REGISTRATION_MESSAGES.addressPincode;

  if (!VEHICLES_WITHOUT_NUMBER.includes(input.vehicleType)) {
    need("vehicleRegistrationNumber", input.vehicleRegistrationNumber, REGISTRATION_MESSAGES.vehicleNumber);
  }
  if (!blank(input.vehicleRegistrationNumber)) {
    const checked = normaliseVehicleRegistration(input.vehicleRegistrationNumber!);
    if (!checked.ok) errors.vehicleRegistrationNumber = checked.error;
  }

  need("emergencyContactName", input.emergencyContactName, REGISTRATION_MESSAGES.emergencyName);
  need("emergencyContactMobile", input.emergencyContactMobile, REGISTRATION_MESSAGES.emergencyMobile);
  if (!blank(input.emergencyContactMobile)) {
    const emergency = input.emergencyContactMobile!.trim();
    if (!isIndianMobile(emergency)) errors.emergencyContactMobile = REGISTRATION_MESSAGES.emergencyMobile;
    else if (emergency === input.mobile) errors.emergencyContactMobile = REGISTRATION_MESSAGES.emergencySame;
  }

  if (options.required && (input.latitude == null || input.longitude == null)) errors.location = REGISTRATION_MESSAGES.location;
  return errors;
}
