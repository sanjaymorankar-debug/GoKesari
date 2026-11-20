import { AppError } from "@/lib/errors";

/** The module is switched off (rule consultBooking): pages 404 and APIs answer "not available". */
export function featureNotAvailableError(): AppError {
  return new AppError("NOT_FOUND", "Consultant bookings are not available yet.", { reason: "FEATURE_NOT_AVAILABLE", feature: "consultBooking" });
}
