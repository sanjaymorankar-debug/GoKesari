/**
 * Delivery-partner vehicle types (delivery-system Part 58 follow-up).
 *
 * An app-level list, not a Postgres enum — the brief calls for vehicle
 * types to be "configurable"; adding one here is a code change, not a
 * schema migration. Mirrors the SHOP_TYPES pattern in shop-types.ts.
 */
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

export interface VehicleTypeDefinition {
  key: string;
  label: string;
}

export const VEHICLE_TYPES = [
  { key: "BICYCLE", label: "Bicycle" },
  { key: "MOTORCYCLE", label: "Motorcycle" },
  { key: "SCOOTER", label: "Scooter" },
  { key: "ELECTRIC_VEHICLE", label: "Electric Vehicle" },
  { key: "OTHER", label: "Other" },
] as const satisfies readonly VehicleTypeDefinition[];

export type VehicleTypeKey = (typeof VEHICLE_TYPES)[number]["key"];

export const VEHICLE_TYPE_KEYS = VEHICLE_TYPES.map((t) => t.key) as [
  VehicleTypeKey,
  ...VehicleTypeKey[],
];

export function vehicleTypeLabel(key: string): string {
  return VEHICLE_TYPES.find((t) => t.key === key)?.label ?? key;
}

/** Module 6: vehicle names in Hindi and Marathi for rider screens. */
const VEHICLE_TYPE_TEXT: Readonly<Record<string, Text>> = {
  BICYCLE: L("Bicycle", "साइकिल", "सायकल"),
  MOTORCYCLE: L("Motorcycle", "मोटरसाइकिल", "मोटारसायकल"),
  SCOOTER: L("Scooter", "स्कूटर", "स्कूटर"),
  ELECTRIC_VEHICLE: L("Electric Vehicle", "इलेक्ट्रिक वाहन", "इलेक्ट्रिक वाहन"),
  OTHER: L("Other", "अन्य", "इतर"),
};

/** The vehicle's name in `lang`; English is exactly `vehicleTypeLabel`. */
export function vehicleTypeText(key: string, lang: Lang): string {
  if (lang === "en") return vehicleTypeLabel(key);
  const text = VEHICLE_TYPE_TEXT[key];
  return text ? tr(text, lang) : vehicleTypeLabel(key);
}
