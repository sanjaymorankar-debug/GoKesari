/**
 * Owner, 25-Nov-2026: admin and operations may continue a shop owner's unfinished registration for
 * them. The wizard's routes are the owner's own; a staff page adds the header below with the draft's
 * id, and the route then acts on that owner's draft, with the staff member named in the audit log.
 * The routes resolve their actor through `wizardActor` (`@/server/api/wizard-actor`), which also
 * handles assisted onboarding (`x-gk-assist-owner`).
 */
import { eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import type { AuthenticatedUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shopRegistrationDrafts, users } from "@/server/db/schema";
import { reopenAbandonedDraft, type Actor } from "@/server/services/shop-registration-draft";

/** Set by the staff wizard page; never by the owner's own page. */
export const STAFF_DRAFT_HEADER = "x-gk-registration-draft";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner of a draft, as the actor the wizard's services expect, with the staff member attached. */
export async function staffActorForDraft(
  draftId: string,
  staff: NonNullable<Actor["staff"]>,
): Promise<AuthenticatedUser & Pick<Actor, "staff">> {
  if (!UUID.test(draftId)) throw notFound("Registration");
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, image: users.image, role: users.role })
    .from(shopRegistrationDrafts)
    .innerJoin(users, eq(users.id, shopRegistrationDrafts.ownerId))
    .where(eq(shopRegistrationDrafts.id, draftId));
  if (!row) throw notFound("Registration");
  // An abandoned registration opens again where it stopped, as it does for the owner.
  await reopenAbandonedDraft(row.id);
  return { ...row, image: row.image ?? null, staff };
}
