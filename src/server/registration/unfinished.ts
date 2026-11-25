/**
 * Owner, 25-Nov-2026: every shop registration that is not finished — still open, left (abandoned
 * after 7 days without a step) or created but unpaid — for admin and operations, with the step it
 * stopped on and what is filled in. Staff continue it for the owner, or send the owner a link to
 * carry on; either way it resumes where it stopped.
 */
import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { sendRegistrationResumeLink } from "@/server/services/scheduled-notices";
import { ABANDONED_AFTER_MS, reopenAbandonedDraft, type Actor } from "@/server/services/shop-registration-draft";
import { notFound } from "@/lib/errors";

export interface UnfinishedRegistration {
  draftId: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  ownerPhone: string | null;
  /** OPEN, ABANDONED (left before 25-Nov-2026) or SUBMITTED (shop created, fee unpaid). */
  status: string;
  /** No step for 7 days or more (or marked so before 25-Nov-2026). */
  abandoned: boolean;
  /** The step the owner last reached. */
  step: string | null;
  business: string | null;
  number: string | null;
  city: string | null;
  referralCode: string | null;
  shopId: string | null;
  idleHours: number;
  startedAt: Date;
}

type Raw = Record<string, unknown>;
const ABANDONED_HOURS = ABANDONED_AFTER_MS / 3_600_000;

export async function listUnfinishedRegistrations(options: { search?: string; only?: "ALL" | "ABANDONED" | "ACTIVE"; limit?: number } = {}): Promise<UnfinishedRegistration[]> {
  const search = options.search?.trim() ? `%${options.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const only = options.only ?? "ALL";
  const rows = (await db.execute(sql`
    select d.id as draft_id, d.owner_id, d.status, d.referral_code, d.shop_id, d.created_at,
           u.name as owner_name, u.email as owner_email, u.phone_e164 as owner_phone,
           coalesce(d.gst_record->>'legalName', d.gst_record->>'tradeName', d.pan_record->>'name', d.details->>'name') as business,
           coalesce(d.gstin_masked, d.pan_masked) as number,
           coalesce(d.details->>'city', d.gst_record->>'pincode') as city,
           (select s.step from shop_onboarding_steps s where s.draft_id = d.id order by s.reached_at desc limit 1) as step,
           floor(extract(epoch from (now() - d.updated_at)) / 3600)::int as idle_hours
    from shop_registration_drafts d
    join users u on u.id = d.owner_id
    left join shops sh on sh.id = d.shop_id
    where (d.status in ('OPEN', 'ABANDONED')
           or (d.status = 'SUBMITTED' and sh.id is not null and sh.deleted_at is null
               and sh.fee_payment_status in ('PENDING', 'PARTIALLY_PAID')
               and coalesce(sh.registration_fee_paise, 0) > coalesce(sh.amount_paid_paise, 0)))
      -- Only the owner's latest registration: an older abandoned one is not shown next to a newer one.
      and not exists (select 1 from shop_registration_drafts n where n.owner_id = d.owner_id and n.created_at > d.created_at)
      and (${search}::text is null or u.email ilike ${search} or u.phone_e164 ilike ${search} or u.name ilike ${search}
           or d.gst_record->>'legalName' ilike ${search} or d.gst_record->>'tradeName' ilike ${search} or d.details->>'name' ilike ${search})
      and (${only}::text = 'ALL'
           or (${only}::text = 'ABANDONED' and (d.status = 'ABANDONED' or d.updated_at < now() - make_interval(hours => ${ABANDONED_HOURS})))
           or (${only}::text = 'ACTIVE' and d.status <> 'ABANDONED' and d.updated_at >= now() - make_interval(hours => ${ABANDONED_HOURS})))
    order by d.updated_at desc
    limit ${options.limit ?? 200}
  `)) as unknown as Raw[];
  return rows.map((r) => {
    const idleHours = Number(r.idle_hours ?? 0);
    return {
      draftId: String(r.draft_id),
      ownerId: String(r.owner_id),
      ownerName: (r.owner_name as string | null) ?? null,
      ownerEmail: String(r.owner_email),
      ownerPhone: (r.owner_phone as string | null) ?? null,
      status: String(r.status),
      abandoned: r.status === "ABANDONED" || idleHours >= ABANDONED_HOURS,
      step: (r.step as string | null) ?? null,
      business: (r.business as string | null) ?? null,
      number: (r.number as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      referralCode: (r.referral_code as string | null) ?? null,
      shopId: (r.shop_id as string | null) ?? null,
      idleHours,
      startedAt: new Date(String(r.created_at)),
    };
  });
}

/** One registration for the staff page, or a 404. */
export async function getUnfinishedRegistration(draftId: string): Promise<{ draftId: string; ownerId: string; ownerName: string | null; ownerEmail: string } | null> {
  const rows = (await db.execute(sql`
    select d.id, d.owner_id, u.name, u.email from shop_registration_drafts d join users u on u.id = d.owner_id where d.id = ${draftId}::uuid
  `)) as unknown as Raw[];
  const r = rows[0];
  return r ? { draftId: String(r.id), ownerId: String(r.owner_id), ownerName: (r.name as string | null) ?? null, ownerEmail: String(r.email) } : null;
}

/** Staff open an owner's registration to continue it: an abandoned one is opened again; audited. */
export async function openRegistrationForStaff(draftId: string, staff: Actor, ipAddress: string | null = null): Promise<void> {
  const reg = await getUnfinishedRegistration(draftId);
  if (!reg) throw notFound("Registration");
  await reopenAbandonedDraft(reg.ownerId);
  await recordAudit({
    actorId: staff.id,
    actorRole: staff.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_STAFF_OPENED,
    entityType: "shop_registration_draft",
    entityId: draftId,
    ipAddress,
    newValue: { ownerId: reg.ownerId },
  });
}

/** Staff send the owner a link to carry on where the registration stopped; audited. */
export async function sendResumeLinkForStaff(draftId: string, staff: Actor, ipAddress: string | null = null): Promise<void> {
  const reg = await getUnfinishedRegistration(draftId);
  if (!reg) throw notFound("Registration");
  await reopenAbandonedDraft(reg.ownerId);
  await sendRegistrationResumeLink(draftId);
  await recordAudit({
    actorId: staff.id,
    actorRole: staff.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_RESUME_SENT,
    entityType: "shop_registration_draft",
    entityId: draftId,
    ipAddress,
    newValue: { ownerId: reg.ownerId },
  });
}
