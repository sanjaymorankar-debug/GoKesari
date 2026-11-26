/**
 * Rider App v2: why a rider turns a job down — the single offer (G1, stored in
 * delivery_orders.reject_reason_code) and Available Deliveries' "Pass". The
 * same four codes as PASS_REASONS in services/rider-job-board.ts.
 * No server imports: shared by the API routes and the client picker.
 */
import { L, type Text } from "@/lib/board/i18n";

export const RIDER_REJECT_REASONS = ["TOO_FAR", "VEHICLE_ISSUE", "ENDING_SHIFT", "OTHER"] as const;
export type RiderRejectReason = (typeof RIDER_REJECT_REASONS)[number];

export const RIDER_REJECT_REASON_LABEL: Record<RiderRejectReason, Text> = {
  TOO_FAR: L("Too far", "बहुत दूर", "खूप लांब"),
  VEHICLE_ISSUE: L("Vehicle issue", "वाहन में दिक्कत", "वाहनात अडचण"),
  ENDING_SHIFT: L("Ending my shift", "शिफ़्ट खत्म कर रहा हूँ", "शिफ्ट संपवत आहे"),
  OTHER: L("Other", "अन्य", "इतर"),
};
