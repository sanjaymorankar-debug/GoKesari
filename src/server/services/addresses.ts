/**
 * Customer delivery addresses (delivery-system Part 58 follow-up, Slice A).
 *
 * The `addresses` table already existed in the schema before this feature —
 * this is the first service/UI to actually populate and manage it.
 * `orders.addressId` is a nullable FK to this table.
 */
import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { addresses, type Address } from "@/server/db/schema";
import { resolveLocationVerification } from "./geocoding";

export interface SaveAddressInput {
  label?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  addressType?: "HOME" | "WORK" | "OTHER";
  line1: string;
  line2?: string | null;
  area?: string | null;
  city: string;
  state?: string | null;
  pincode: string;
  landmark?: string | null;
  deliveryInstructions?: string | null;
  /** Present when the customer confirmed a pin on the map picker. */
  latitude?: number | null;
  longitude?: number | null;
  isDefault?: boolean;
}

function validate(input: SaveAddressInput): void {
  if (!input.line1.trim()) throw validationFailed("Enter the address.");
  if (!input.city.trim()) throw validationFailed("Enter the city.");
  if (!/^\d{6}$/.test(input.pincode.trim())) {
    throw validationFailed("Enter a valid 6-digit PIN code.");
  }
  if (input.recipientPhone && !/^[6-9]\d{9}$/.test(input.recipientPhone.trim())) {
    throw validationFailed("Enter a valid 10-digit mobile number for the recipient.");
  }
}

/**
 * Verifies (if coordinates were supplied and Geocoding is configured) then
 * saves a new address. Coordinates are optional — a customer without a map
 * picker available can still save a plain-text address; it just won't carry
 * verified lat/long for delivery-distance calculations.
 */
export async function createAddress(
  userId: string,
  input: SaveAddressInput,
): Promise<Address> {
  validate(input);

  const { locationVerified, locationVerifiedAt, locationSource } =
    await resolveLocationVerification(input.latitude, input.longitude, "address_save", "address");

  if (input.isDefault) {
    await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
  }

  const [address] = await db
    .insert(addresses)
    .values({
      userId,
      label: input.label ?? null,
      recipientName: input.recipientName?.trim() || null,
      recipientPhone: input.recipientPhone?.trim() || null,
      addressType: input.addressType ?? "OTHER",
      line1: input.line1.trim(),
      line2: input.line2?.trim() || null,
      area: input.area?.trim() || null,
      city: input.city.trim(),
      state: input.state?.trim() || null,
      pincode: input.pincode.trim(),
      landmark: input.landmark?.trim() || null,
      deliveryInstructions: input.deliveryInstructions?.trim() || null,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      locationVerified,
      locationVerifiedAt,
      locationSource,
      isDefault: input.isDefault ?? false,
    })
    .returning();

  return address;
}

export async function updateAddress(
  userId: string,
  addressId: string,
  input: SaveAddressInput,
): Promise<Address> {
  validate(input);

  const existing = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, addressId), eq(addresses.userId, userId), isNull(addresses.deletedAt)),
  });
  if (!existing) throw notFound("Address");

  const coordinatesChanged =
    input.latitude != null &&
    input.longitude != null &&
    (String(input.latitude) !== existing.latitude || String(input.longitude) !== existing.longitude);

  // Re-verify only if the pin actually moved — an update that leaves
  // coordinates untouched keeps whatever verification status it already had.
  const { locationVerified, locationVerifiedAt, locationSource } = coordinatesChanged
    ? await resolveLocationVerification(input.latitude, input.longitude, "address_update", "address", addressId)
    : { locationVerified: existing.locationVerified, locationVerifiedAt: existing.locationVerifiedAt, locationSource: existing.locationSource };

  if (input.isDefault) {
    await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
  }

  const [updated] = await db
    .update(addresses)
    .set({
      label: input.label ?? null,
      recipientName: input.recipientName?.trim() || null,
      recipientPhone: input.recipientPhone?.trim() || null,
      addressType: input.addressType ?? existing.addressType,
      line1: input.line1.trim(),
      line2: input.line2?.trim() || null,
      area: input.area?.trim() || null,
      city: input.city.trim(),
      state: input.state?.trim() || null,
      pincode: input.pincode.trim(),
      landmark: input.landmark?.trim() || null,
      deliveryInstructions: input.deliveryInstructions?.trim() || null,
      latitude: input.latitude != null ? String(input.latitude) : existing.latitude,
      longitude: input.longitude != null ? String(input.longitude) : existing.longitude,
      locationVerified,
      locationVerifiedAt,
      locationSource,
      isDefault: input.isDefault ?? existing.isDefault,
    })
    .where(eq(addresses.id, addressId))
    .returning();

  return updated;
}

async function listAddressesUncached(userId: string): Promise<Address[]> {
  return db.query.addresses.findMany({
    where: and(eq(addresses.userId, userId), isNull(addresses.deletedAt)),
    orderBy: (a, { desc }) => [desc(a.isDefault), desc(a.createdAt)],
  });
}

/** Memoised for one server render (layout, header and board all ask); API routes and actions call straight through. */
export const listAddresses = cache(listAddressesUncached);

export async function getAddress(userId: string, addressId: string): Promise<Address> {
  const address = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, addressId), eq(addresses.userId, userId), isNull(addresses.deletedAt)),
  });
  if (!address) throw notFound("Address");
  return address;
}

export async function deleteAddress(userId: string, addressId: string): Promise<void> {
  const existing = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, addressId), isNull(addresses.deletedAt)),
  });
  if (!existing) throw notFound("Address");
  if (existing.userId !== userId) throw forbidden("This address does not belong to you.");

  await db.update(addresses).set({ deletedAt: new Date() }).where(eq(addresses.id, addressId));
}
