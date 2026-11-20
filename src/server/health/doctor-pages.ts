/** GoKesari Health: what the doctor / clinic pages need to start (clinics the user works for, seats). */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/server/db";
import { consultMembers, consultProfiles, shops } from "@/server/db/schema";
import type { HealthActor } from "./access";
import { doctorSeatsFor, type DoctorSeat } from "./doctors";

export interface ClinicContext {
  shops: { id: string; name: string }[];
  seats: DoctorSeat[];
  /** The user is a doctor themself (can open the pad), not only reception. */
  canConsult: boolean;
}

/** Clinics with a booking profile that the user owns or works in (owner, doctor, reception member). */
export async function clinicContext(actor: HealthActor): Promise<ClinicContext> {
  const owned = await db.select({ id: shops.id, name: shops.name }).from(shops).innerJoin(consultProfiles, eq(consultProfiles.shopId, shops.id)).where(and(eq(shops.ownerId, actor.id), isNull(shops.deletedAt)));
  const memberOf = await db
    .select({ id: shops.id, name: shops.name })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .where(and(eq(consultMembers.userId, actor.id), eq(consultMembers.status, "ACTIVE")));
  const map = new Map<string, { id: string; name: string }>();
  for (const s of [...owned, ...memberOf]) map.set(s.id, s);
  const seats = await doctorSeatsFor(actor);
  const ids = [...map.keys()];
  return { shops: ids.length ? [...map.values()].sort((a, b) => a.name.localeCompare(b.name)) : [], seats: seats.filter((s) => ids.includes(s.shopId)), canConsult: seats.some((s) => s.verified || s.isDoctor) };
}
