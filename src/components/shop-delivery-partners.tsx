"use client";

import { useState } from "react";

import { Badge, Card } from "@/components/ui";

export interface ShopPartnerSociety {
  societyId: string;
  name: string;
  area: string | null;
  city: string;
}

export interface ShopPartnerRow {
  deliveryPartnerId: string;
  riderId: string;
  name: string;
  photoUrl: string | null;
  vehicleLabel: string;
  ordersDelivered: number;
  lastOrderAt: string;
  authorised: ShopPartnerSociety[];
  blocked: ShopPartnerSociety[];
}

function SocietyList({ societies, empty }: { societies: ShopPartnerSociety[]; empty: string }) {
  if (societies.length === 0) return <p className="text-xs text-ink-500">{empty}</p>;
  return (
    <ul className="list-disc pl-5 text-sm text-ink-700">
      {societies.map((s) => (
        <li key={s.societyId}>
          {s.name}
          {s.area ? `, ${s.area}` : ""}, {s.city}
        </li>
      ))}
    </ul>
  );
}

/**
 * Gig worker flow (feature 7): for each delivery partner, the number of
 * societies that authorise them and the number that block them — tap a count
 * to see the list.
 */
export function ShopDeliveryPartners({ partners }: { partners: ShopPartnerRow[] }) {
  const [open, setOpen] = useState<Record<string, "authorised" | "blocked" | null>>({});
  return (
    <div className="space-y-3">
      {partners.map((p) => {
        const showing = open[p.deliveryPartnerId] ?? null;
        const toggle = (kind: "authorised" | "blocked") =>
          setOpen((current) => ({ ...current, [p.deliveryPartnerId]: current[p.deliveryPartnerId] === kind ? null : kind }));
        return (
          <Card key={p.deliveryPartnerId} className="space-y-3 p-4" data-testid="shop-delivery-partner">
            <div className="flex items-center gap-3">
              {p.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- access-checked /api/images link
                <img src={p.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cream-200 text-lg font-semibold text-ink-600">
                  {p.name.slice(0, 1)}
                </div>
              )}
              <div>
                <p className="font-semibold text-ink-900">{p.name}</p>
                <p className="text-xs text-ink-500">
                  {p.riderId} · {p.vehicleLabel} · {p.ordersDelivered} of your orders delivered · last on{" "}
                  {new Date(p.lastOrderAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => toggle("authorised")}
                aria-expanded={showing === "authorised"}
                className="rounded-lg border border-cream-200 px-3 py-2 text-sm hover:bg-cream-100"
                data-testid="authorised-count"
              >
                Authorised societies <Badge tone="success">{p.authorised.length}</Badge>
              </button>
              <button
                type="button"
                onClick={() => toggle("blocked")}
                aria-expanded={showing === "blocked"}
                className="rounded-lg border border-cream-200 px-3 py-2 text-sm hover:bg-cream-100"
                data-testid="blocked-count"
              >
                Blocked societies <Badge tone="danger">{p.blocked.length}</Badge>
              </button>
            </div>
            {showing === "authorised" ? <SocietyList societies={p.authorised} empty="No society has authorised this partner yet." /> : null}
            {showing === "blocked" ? <SocietyList societies={p.blocked} empty="No society blocks this partner." /> : null}
          </Card>
        );
      })}
    </div>
  );
}
