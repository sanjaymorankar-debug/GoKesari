import { LocationPicker } from "@/components/location-picker";
import type { CustomerLocation } from "@/lib/location";
import { listAddresses } from "@/server/services/addresses";

/**
 * Server wrapper for the "Deliver to" picker: supplies the signed-in user's
 * saved addresses. Pages resolve the location themselves (they also need it
 * to filter results), and pass it in.
 */
export async function LocationBar({
  userId,
  location,
}: {
  userId: string | null;
  location: CustomerLocation | null;
}) {
  const addresses = userId ? await listAddresses(userId) : [];
  return (
    <LocationPicker
      currentLabel={location?.label ?? null}
      savedAddresses={addresses.map((a) => ({
        id: a.id,
        label: `${a.label ? `${a.label} — ` : ""}${a.pincode}`,
      }))}
    />
  );
}
