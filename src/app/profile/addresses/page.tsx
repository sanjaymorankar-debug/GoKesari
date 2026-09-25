import { redirect } from "next/navigation";

import { AddressManager } from "@/components/address-manager";
import { AddressSocietySelect } from "@/components/society-actions";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listAddresses } from "@/server/services/addresses";
import { listMySocieties } from "@/server/services/societies";

export const metadata = { title: "My Addresses" };
export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [addresses, memberships] = await Promise.all([listAddresses(user.id), listMySocieties(user.id)]);
  // Only verified societies the user actively belongs to can be linked (GS-005).
  const societyOptions = memberships
    .filter((m) => m.membership.status === "ACTIVE" && m.society.status === "VERIFIED")
    .map((m) => ({ id: m.society.id, name: m.society.name }));

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="My Addresses"
        description="Saved delivery addresses, used at checkout."
      />
      <AddressManager
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          line2: a.line2,
          area: a.area,
          city: a.city,
          state: a.state,
          pincode: a.pincode,
          landmark: a.landmark,
          deliveryInstructions: a.deliveryInstructions,
          latitude: a.latitude,
          longitude: a.longitude,
          locationVerified: a.locationVerified,
          isDefault: a.isDefault,
        }))}
      />
      {addresses.length > 0 && societyOptions.length > 0 ? (
        <div className="mt-6 rounded-xl border border-cream-200 bg-white p-4" data-testid="address-societies">
          <h2 className="mb-2 text-sm font-semibold text-ink-900">Society for each address</h2>
          <ul className="space-y-2 text-sm">
            {addresses.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{a.label ?? a.line1}</span>
                <AddressSocietySelect addressId={a.id} current={a.societyId} options={societyOptions} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
