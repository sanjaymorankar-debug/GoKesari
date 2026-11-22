"use client";

/**
 * Health admin → Specialties (owner, 21-Nov-2026): every medical practitioner by Health group. For each
 * group: the bookable specialties (consultant categories — what "Find a doctor" and bookings use) and the
 * same group in the registration list (shop categories). Read-only: editing stays in Consultants →
 * Categories and Shop categories, linked from here.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui";
import type { HealthSpecialtyGroupView } from "@/server/health/admin";
import { api, Panel } from "./api";
import { ADMIN_API, Loading, Nothing } from "./admin-common";

export function Specialties() {
  const [groups, setGroups] = useState<HealthSpecialtyGroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ groups: HealthSpecialtyGroupView[] }>(`${ADMIN_API}?view=specialties`)
      .then((r) => setGroups(r.groups))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the specialties."));
  }, []);
  if (error) return <Nothing>{error}</Nothing>;
  if (groups === null) return <Loading />;
  return (
    <div className="flex flex-col gap-3" data-testid="health-specialties-admin">
      <p className="text-sm text-ink-700">
        Every medical practitioner, by Health group. Patients pick a group first on &quot;Find a doctor&quot;, then a specialty. Rename, add or switch off a specialty
        in{" "}
        <Link href="/admin/consult?tab=categories" className="font-bold text-kesari-800 underline">
          Consultants → Categories
        </Link>{" "}
        (bookings, commission) and in{" "}
        <Link href="/admin/shop-categories" className="font-bold text-kesari-800 underline">
          Shop categories
        </Link>{" "}
        (registration). A new one joins a group when its group is the exact group name shown here.
      </p>
      {groups.map((g) => (
        <Panel key={g.key} title={g.short}>
          <div data-testid={`health-specialty-group-${g.key}`} className="flex flex-col gap-2">
            <p className="text-xs text-ink-600">Group name: {g.name}</p>
            {g.specialties.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {g.specialties.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-100 py-1">
                    <span>
                      <strong>{s.name}</strong> {s.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}{" "}
                      {s.inDoctorSearch ? <Badge tone="success">Find a doctor</Badge> : null}
                    </span>
                    <span className="text-xs text-ink-600">
                      {s.requiredDoc === "NONE" ? "No certificate" : (s.requiredDocLabel ?? "Certificate needed")} · {s.providers} doctor(s) / provider(s)
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-600">No bookable specialty in this group yet.</p>
            )}
            {g.shopCategories.length ? (
              <p className="text-xs text-ink-700">
                <span className="font-bold">Registration list: </span>
                {g.shopCategories.map((c) => `${c.name}${c.status === "INACTIVE" ? " (off)" : ""} — ${c.shops} shop(s)`).join(" · ")}
              </p>
            ) : null}
          </div>
        </Panel>
      ))}
    </div>
  );
}
