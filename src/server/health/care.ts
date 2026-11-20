/**
 * GoKesari Health: home care (nurse, physiotherapist, massage therapist, attendant …) — visits, OTP
 * check-in / check-out, notes and vitals into the patient's record, packages, SOS.
 * (Being built: docs/health/README.md "Home care".)
 */
import type { ConsultBooking, HealthPatient } from "@/server/db/schema";

/** Called by createHealthBooking after a booking is linked to a patient: starts a care visit for home-care categories. */
export async function onHealthBookingCreated(booking: ConsultBooking, patient: HealthPatient): Promise<void> {
  void booking;
  void patient;
}
