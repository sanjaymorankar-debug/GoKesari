/**
 * RBAC v2 Phase 6 — customer onboarding assists (docs/rbac/06-operations.md §Customers).
 *
 * An Operations User records a customer they are helping (an enquiry), helps them open GoKesari's
 * normal sign-in on the customer's own phone, and the customer confirms with the e-mailed sign-in
 * code themselves. The login mechanism is not touched (brief §0.3): no account is created here and
 * no code is sent from here.
 *
 * The assist is linked to the account afterwards: an account whose e-mail or mobile matches the
 * assist and that was created after the assist was recorded becomes REGISTERED (PROFILE_COMPLETE
 * once the profile is filled in). The link is made when the assists are read (lists, dashboard,
 * reports) — no change to the sign-up code and no cron.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { normalizeEmail } from "@/lib/contact";
import { db } from "@/server/db";
import { opsCustomerAssists, type OpsAssistStatus, type OpsCustomerAssist } from "@/server/db/ops-schema";
import { users } from "@/server/db/schema";
import { denyNotOwn, isOpsManager, requireOps, type OpsActor } from "./access";
import { managedUserIds } from "./tasks";

const inScope = (scope: string[] | null, userId: string) => scope === null || scope.includes(userId);

const PINCODE = /^[1-9][0-9]{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Last 10 digits of an Indian mobile number, or null. */
export function mobileKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

async function zoneForPincode(pincode: string | null): Promise<string | null> {
  if (!pincode) return null;
  const rows = (await db.execute(sql`
    select zone_id from franchise_areas
    where ${pincode} = any(pincodes) and zone_id is not null and is_test = false
    order by area_no limit 1`)) as unknown as { zone_id: string }[];
  return rows[0]?.zone_id ?? null;
}

export interface CreateAssistInput {
  customerName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  pincode?: string | null;
  notes?: string | null;
  followUpAt?: Date | null;
}

export async function createCustomerAssist(actor: OpsActor, input: CreateAssistInput): Promise<OpsCustomerAssist> {
  await requireOps(actor, "assist");
  const name = input.customerName.trim();
  if (name.length < 2) throw validationFailed("Enter the customer's name.");
  const email = input.contactEmail?.trim() ? normalizeEmail(input.contactEmail) : null;
  if (email && !EMAIL.test(email)) throw validationFailed("Enter a valid e-mail address.");
  const phone = input.contactPhone?.trim() ? mobileKey(input.contactPhone) : null;
  if (input.contactPhone?.trim() && !phone) throw validationFailed("Enter a 10-digit mobile number.");
  if (!email && !phone) throw validationFailed("Enter the customer's e-mail or mobile number.");
  const pincode = input.pincode?.trim() || null;
  if (pincode && !PINCODE.test(pincode)) throw validationFailed("Enter a 6-digit pincode.");
  const [row] = await db
    .insert(opsCustomerAssists)
    .values({
      opsUserId: actor.id,
      customerName: name,
      contactEmail: email,
      contactPhone: phone,
      pincode,
      zoneId: await zoneForPincode(pincode),
      notes: input.notes?.trim() || null,
      followUpAt: input.followUpAt ?? null,
    })
    .returning();
  return row;
}

export async function updateCustomerAssist(
  actor: OpsActor,
  id: string,
  input: { status?: Extract<OpsAssistStatus, "ENQUIRY" | "INVITED" | "DROPPED">; notes?: string | null; followUpAt?: Date | null },
): Promise<OpsCustomerAssist> {
  await requireOps(actor, "assist", "manage");
  const [assist] = await db.select().from(opsCustomerAssists).where(eq(opsCustomerAssists.id, id));
  if (!assist) throw notFound("Customer");
  if (assist.opsUserId !== actor.id && !(isOpsManager(actor) && inScope(await managedUserIds(actor), assist.opsUserId))) denyNotOwn(actor, "assist");
  if (input.status && (assist.status === "REGISTERED" || assist.status === "PROFILE_COMPLETE")) {
    throw validationFailed("This customer has already registered.");
  }
  const [row] = await db
    .update(opsCustomerAssists)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      ...(input.followUpAt !== undefined ? { followUpAt: input.followUpAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(opsCustomerAssists.id, id))
    .returning();
  return row;
}

/**
 * Links assists to the accounts the customers opened. Idempotent; one statement each. An account
 * already linked to another assist is not linked twice (unique index).
 */
export async function syncAssistRegistrations(): Promise<number> {
  const linked = (await db.execute(sql`
    with cand as (
      select distinct on (u.id) a.id as assist_id, u.id as user_id, u.created_at, u.profile_completed_at
      from ops_customer_assists a
      join users u on u.deleted_at is null
        and u.created_at >= a.created_at - interval '1 hour'
        and ((a.contact_email is not null and lower(u.email) = lower(a.contact_email))
          or (a.contact_phone is not null and right(regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g'), 10) = a.contact_phone))
      where a.customer_user_id is null and a.status <> 'DROPPED'
        and not exists (select 1 from ops_customer_assists x where x.customer_user_id = u.id)
      order by u.id, a.created_at asc
    )
    update ops_customer_assists a
    set customer_user_id = cand.user_id,
        registered_at = cand.created_at,
        status = case when cand.profile_completed_at is not null then 'PROFILE_COMPLETE' else 'REGISTERED' end,
        updated_at = now()
    from cand where a.id = cand.assist_id
    returning a.id`)) as unknown as unknown[];
  await db.execute(sql`
    update ops_customer_assists a set status = 'PROFILE_COMPLETE', updated_at = now()
    from users u
    where a.customer_user_id = u.id and a.status = 'REGISTERED' and u.profile_completed_at is not null`);
  return linked.length;
}

export interface CustomerAssistView extends OpsCustomerAssist {
  opsUserName: string | null;
}

export async function listCustomerAssists(actor: OpsActor, filter: { opsUserId?: string; open?: boolean } = {}): Promise<CustomerAssistView[]> {
  await requireOps(actor, "assist", "manage");
  await syncAssistRegistrations();
  const conds = [];
  if (!isOpsManager(actor)) conds.push(eq(opsCustomerAssists.opsUserId, actor.id));
  else {
    const scope = await managedUserIds(actor);
    if (scope !== null) conds.push(scope.length ? inArray(opsCustomerAssists.opsUserId, scope) : sql`false`);
    if (filter.opsUserId) conds.push(eq(opsCustomerAssists.opsUserId, filter.opsUserId));
  }
  if (filter.open) conds.push(sql`${opsCustomerAssists.status} in ('ENQUIRY','INVITED')`);
  const rows = await db
    .select({ a: opsCustomerAssists, opsUserName: users.name })
    .from(opsCustomerAssists)
    .leftJoin(users, eq(users.id, opsCustomerAssists.opsUserId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(opsCustomerAssists.createdAt))
    .limit(300);
  return rows.map((r) => ({ ...r.a, opsUserName: r.opsUserName }));
}
