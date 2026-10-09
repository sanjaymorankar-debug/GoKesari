/**
 * Customer segments and shop campaigns (GS-052, GS-053, WF-009, KPI-015).
 *
 *   segment (the shop's own customers, by locality / purchases / recency)
 *   → campaign DRAFT → SUBMITTED → APPROVED by operations → SENT
 *     (or REJECTED — edit and resubmit — or CANCELLED)
 *   → in-app message to consenting customers, within budget and frequency caps
 *   → tracking: sent, opened (notification read), converted (ordered from
 *     the shop within the attribution days), revenue.
 *
 * Privacy: a shop only ever sees counts — never who its customers are — and
 * only customers who have granted marketing consent (GS-070) are messaged.
 * A shop can only segment customers who ordered from it.
 *
 * Limits (defaults, pending business confirmation): a shop may have at most
 * 2 campaigns submitted / approved / sent per 7 days; a customer receives at
 * most 1 campaign per shop and 3 campaigns in total per 7 days.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  campaignRecipients,
  customerSegments,
  marketingCampaigns,
  notifications,
  shops,
  type CampaignStatus,
  type CustomerSegment,
  type MarketingCampaign,
  type SegmentRules,
  type UserRole,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

/** Code defaults; the live values are rule `marketing` (Admin → Business rules). */
export const MARKETING_LIMITS = RULES.marketing.defaults;

interface Actor {
  id: string;
  role: UserRole;
}

type Row = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

/* ============================================================ segments */

export function normaliseRules(input: SegmentRules): SegmentRules {
  const rules: SegmentRules = {};
  if (input.pincodes?.length) {
    const pins = [...new Set(input.pincodes.map((p) => p.trim()).filter(Boolean))];
    if (pins.some((p) => !/^\d{6}$/.test(p))) throw validationFailed("PIN codes must be 6 digits.");
    if (pins.length > 50) throw validationFailed("At most 50 PIN codes per segment.");
    rules.pincodes = pins;
  }
  if (input.societyIds?.length) rules.societyIds = [...new Set(input.societyIds)].slice(0, 50);
  const whole = (value: number | undefined, label: string, min: number, max: number) => {
    if (value == null) return undefined;
    if (!Number.isInteger(value) || value < min || value > max) throw validationFailed(`${label} must be between ${min} and ${max}.`);
    return value;
  };
  rules.minOrders = whole(input.minOrders, "Minimum orders", 1, 1000);
  rules.orderedWithinDays = whole(input.orderedWithinDays, "Ordered within (days)", 1, 365);
  rules.lapsedForDays = whole(input.lapsedForDays, "Not ordered for (days)", 1, 365);
  rules.minSpendPaise = whole(input.minSpendPaise, "Minimum spend", 1, 100_000_000);
  if (rules.orderedWithinDays && rules.lapsedForDays && rules.lapsedForDays >= rules.orderedWithinDays) {
    throw validationFailed("'Ordered within' must be longer than 'not ordered for' — otherwise nobody matches.");
  }
  return Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined)) as SegmentRules;
}

const placedByShop = (shopId: string) => sql`o.shop_id = ${shopId}
  and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')`;

const hasMarketingConsent = (userColumn: SQL) => sql`coalesce((select uc.granted from user_consents uc
  where uc.user_id = ${userColumn} and uc.consent_type = 'MARKETING_COMMUNICATIONS'
  order by uc.created_at desc limit 1), false)`;

/** The shop's customers matching `rules` (user id + consent), as a SQL subquery. */
function audienceQuery(shopId: string, rules: SegmentRules): SQL {
  const having: SQL[] = [sql`true`];
  if (rules.minOrders) having.push(sql`count(*) filter (where o.status in ('DELIVERED', 'DISPUTED')) >= ${rules.minOrders}`);
  if (rules.minSpendPaise) {
    having.push(sql`coalesce(sum(o.total_paise) filter (where o.status in ('DELIVERED', 'DISPUTED')), 0) >= ${rules.minSpendPaise}`);
  }
  if (rules.orderedWithinDays) having.push(sql`max(o.created_at) >= now() - make_interval(days => ${rules.orderedWithinDays})`);
  if (rules.lapsedForDays) having.push(sql`max(o.created_at) < now() - make_interval(days => ${rules.lapsedForDays})`);
  if (rules.pincodes?.length) {
    having.push(sql`bool_or(o.delivery_address_snapshot->>'pincode' in (${sql.join(rules.pincodes.map((p) => sql`${p}`), sql`, `)}))`);
  }
  if (rules.societyIds?.length) {
    having.push(sql`bool_or(o.society_id in (${sql.join(rules.societyIds.map((id) => sql`${id}::uuid`), sql`, `)}))`);
  }
  return sql`(select o.user_id, ${hasMarketingConsent(sql`o.user_id`)} as consent
    from orders o join users u on u.id = o.user_id
    where ${placedByShop(shopId)} and u.status = 'ACTIVE' and u.deleted_at is null
    group by o.user_id
    having ${sql.join(having, sql` and `)})`;
}

export interface AudiencePreview {
  matched: number;
  reachable: number;
}

export async function previewAudience(shopId: string, rules: SegmentRules): Promise<AudiencePreview> {
  const normalised = normaliseRules(rules);
  const [row] = (await db.execute(sql`
    select count(*)::int as matched, count(*) filter (where a.consent)::int as reachable
    from ${audienceQuery(shopId, normalised)} a`)) as unknown as Row[];
  return { matched: n(row?.matched), reachable: n(row?.reachable) };
}

/** Headline customer counts for the shop's marketing page (never identities). */
export async function getShopCustomerOverview(shopId: string) {
  const [row] = (await db.execute(sql`
    select count(*)::int as customers,
      count(*) filter (where c.consent)::int as consenting,
      count(*) filter (where c.delivered >= 2)::int as repeat,
      count(*) filter (where c.last_order < now() - interval '30 days')::int as lapsed
    from (
      select o.user_id, ${hasMarketingConsent(sql`o.user_id`)} as consent,
        count(*) filter (where o.status in ('DELIVERED', 'DISPUTED')) as delivered,
        max(o.created_at) as last_order
      from orders o where ${placedByShop(shopId)} group by o.user_id
    ) c`)) as unknown as Row[];
  return {
    customers: n(row?.customers),
    consenting: n(row?.consenting),
    repeat: n(row?.repeat),
    lapsed: n(row?.lapsed),
  };
}

export async function listSegments(shopId: string): Promise<(CustomerSegment & AudiencePreview)[]> {
  const rows = await db
    .select()
    .from(customerSegments)
    .where(and(eq(customerSegments.shopId, shopId), isNull(customerSegments.deletedAt)))
    .orderBy(desc(customerSegments.createdAt));
  const result = [];
  for (const segment of rows) {
    result.push({ ...segment, ...(await previewAudience(shopId, segment.rules)) });
  }
  return result;
}

export async function saveSegment(
  shopId: string,
  input: { id?: string | null; name: string; rules: SegmentRules },
  actor: Actor,
): Promise<CustomerSegment> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw validationFailed("Give the segment a name (2–80 characters).");
  const rules = normaliseRules(input.rules);

  let saved: CustomerSegment;
  if (input.id) {
    const [updated] = await db
      .update(customerSegments)
      .set({ name, rules, updatedAt: new Date() })
      .where(and(eq(customerSegments.id, input.id), eq(customerSegments.shopId, shopId), isNull(customerSegments.deletedAt)))
      .returning();
    if (!updated) throw notFound("Segment");
    saved = updated;
  } else {
    [saved] = await db.insert(customerSegments).values({ shopId, name, rules, createdBy: actor.id }).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SEGMENT_SAVED,
    entityType: "customer_segment",
    entityId: saved.id,
    newValue: { shopId, name, rules },
  });
  return saved;
}

export async function deleteSegment(shopId: string, segmentId: string, actor: Actor): Promise<void> {
  const [inUse] = await db
    .select({ id: marketingCampaigns.id })
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.segmentId, segmentId), inArray(marketingCampaigns.status, ["DRAFT", "SUBMITTED", "APPROVED"])))
    .limit(1);
  if (inUse) throw conflict("A campaign still uses this segment — cancel or send it first.");
  const [deleted] = await db
    .update(customerSegments)
    .set({ deletedAt: new Date() })
    .where(and(eq(customerSegments.id, segmentId), eq(customerSegments.shopId, shopId), isNull(customerSegments.deletedAt)))
    .returning();
  if (!deleted) throw notFound("Segment");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SEGMENT_DELETED,
    entityType: "customer_segment",
    entityId: segmentId,
  });
}

/* =========================================================== campaigns */

export interface CampaignInput {
  segmentId: string;
  title: string;
  message: string;
  offerText?: string | null;
  maxRecipients: number;
  attributionDays?: number;
}

function validateCampaign(input: CampaignInput, limits: { maxRecipients: number } = MARKETING_LIMITS) {
  const title = input.title.trim();
  const message = input.message.trim();
  if (title.length < 3 || title.length > 80) throw validationFailed("Title must be 3–80 characters.");
  if (message.length < 10 || message.length > 500) throw validationFailed("Message must be 10–500 characters.");
  const offerText = input.offerText?.trim() || null;
  if (offerText && offerText.length > 120) throw validationFailed("Offer line must be at most 120 characters.");
  if (!Number.isInteger(input.maxRecipients) || input.maxRecipients < 1 || input.maxRecipients > limits.maxRecipients) {
    throw validationFailed(`Budget must be between 1 and ${limits.maxRecipients} customers.`);
  }
  const attributionDays = input.attributionDays ?? 7;
  if (!Number.isInteger(attributionDays) || attributionDays < 1 || attributionDays > 30) {
    throw validationFailed("Attribution window must be 1–30 days.");
  }
  return { title, message, offerText, maxRecipients: input.maxRecipients, attributionDays };
}

async function loadCampaign(campaignId: string, shopId?: string): Promise<MarketingCampaign> {
  const campaign = await db.query.marketingCampaigns.findFirst({ where: eq(marketingCampaigns.id, campaignId) });
  if (!campaign || (shopId && campaign.shopId !== shopId)) throw notFound("Campaign");
  return campaign;
}

async function audit(campaign: MarketingCampaign, actor: Actor, action: AuditAction, from: CampaignStatus | null, extra: Record<string, unknown> = {}) {
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action,
    entityType: "marketing_campaign",
    entityId: campaign.id,
    previousValue: from ? { status: from } : undefined,
    newValue: { status: campaign.status, shopId: campaign.shopId, ...extra },
  });
}

export async function saveCampaign(
  shopId: string,
  input: CampaignInput & { id?: string | null },
  actor: Actor,
): Promise<MarketingCampaign> {
  const values = validateCampaign(input, await getRule("marketing"));
  const segment = await db.query.customerSegments.findFirst({
    where: and(eq(customerSegments.id, input.segmentId), eq(customerSegments.shopId, shopId), isNull(customerSegments.deletedAt)),
  });
  if (!segment) throw notFound("Segment");

  let campaign: MarketingCampaign;
  if (input.id) {
    const current = await loadCampaign(input.id, shopId);
    if (current.status !== "DRAFT" && current.status !== "REJECTED") {
      throw conflict("Only a draft or rejected campaign can be edited.");
    }
    [campaign] = await db
      .update(marketingCampaigns)
      .set({ ...values, segmentId: segment.id, status: "DRAFT", rejectionReason: null, updatedAt: new Date() })
      .where(eq(marketingCampaigns.id, current.id))
      .returning();
  } else {
    [campaign] = await db
      .insert(marketingCampaigns)
      .values({ ...values, shopId, segmentId: segment.id, createdBy: actor.id })
      .returning();
  }
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_SAVED, null, { title: values.title, maxRecipients: values.maxRecipients });
  return campaign;
}

/** Shop rate limit: campaigns submitted, approved or sent in the last 7 days. */
async function recentCampaignCount(shopId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.shopId, shopId),
        inArray(marketingCampaigns.status, ["SUBMITTED", "APPROVED", "SENT"]),
        sql`coalesce(${marketingCampaigns.sentAt}, ${marketingCampaigns.submittedAt}) > now() - interval '7 days'`,
      ),
    );
  return row.n;
}

export async function submitCampaign(shopId: string, campaignId: string, actor: Actor): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  if (current.status !== "DRAFT" && current.status !== "REJECTED") throw conflict("This campaign has already been submitted.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "APPROVED") throw conflict("Only an approved shop can run campaigns.");
  const limits = await getRule("marketing");
  if ((await recentCampaignCount(shopId)) >= limits.shopCampaignsPerWeek) {
    throw conflict(`A shop can run at most ${limits.shopCampaignsPerWeek} campaigns a week.`);
  }
  const [campaign] = await db
    .update(marketingCampaigns)
    .set({ status: "SUBMITTED", submittedAt: new Date(), rejectionReason: null, updatedAt: new Date() })
    .where(and(eq(marketingCampaigns.id, campaignId), inArray(marketingCampaigns.status, ["DRAFT", "REJECTED"])))
    .returning();
  if (!campaign) throw conflict("This campaign has already been submitted.");
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED, current.status);
  return campaign;
}

/** Operations approves or rejects a submitted campaign (WF-009 approval step). */
export async function decideCampaign(
  campaignId: string,
  decision: "approve" | "reject",
  reason: string | null,
  actor: Actor,
): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId);
  if (current.status !== "SUBMITTED") throw conflict("Only a submitted campaign can be approved or rejected.");
  const trimmed = reason?.trim() || null;
  if (decision === "reject" && (!trimmed || trimmed.length < 3)) throw validationFailed("Say why the campaign is rejected.");

  const [campaign] = await db
    .update(marketingCampaigns)
    .set({
      status: decision === "approve" ? "APPROVED" : "REJECTED",
      decidedBy: actor.id,
      decidedAt: new Date(),
      rejectionReason: decision === "reject" ? trimmed : null,
      updatedAt: new Date(),
    })
    .where(and(eq(marketingCampaigns.id, campaignId), eq(marketingCampaigns.status, "SUBMITTED")))
    .returning();
  if (!campaign) throw conflict("This campaign has already been decided.");
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED, "SUBMITTED", { reason: trimmed });

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, campaign.shopId) });
  if (shop) {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.CAMPAIGN_DECIDED,
      title: decision === "approve" ? "Campaign approved" : "Campaign needs changes",
      body:
        decision === "approve"
          ? `"${campaign.title}" is approved — send it from your marketing page.`
          : `"${campaign.title}" was not approved: ${trimmed}`,
      actionUrl: "/shop/marketing",
    });
  }
  return campaign;
}

export async function cancelCampaign(shopId: string, campaignId: string, actor: Actor): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  const [campaign] = await db
    .update(marketingCampaigns)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(marketingCampaigns.id, campaignId), inArray(marketingCampaigns.status, ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"])))
    .returning();
  if (!campaign) throw conflict("A sent or cancelled campaign cannot be cancelled.");
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED, current.status);
  return campaign;
}

/**
 * Sends an APPROVED campaign: consenting customers of the segment, minus
 * anyone at a frequency cap, up to the budget. Each gets one in-app message.
 */
export async function sendCampaign(shopId: string, campaignId: string, actor: Actor): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  if (current.status !== "APPROVED") throw conflict("Only an approved campaign can be sent.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "APPROVED") throw forbidden("Only an approved shop can send campaigns.");
  const segment = await db.query.customerSegments.findFirst({ where: eq(customerSegments.id, current.segmentId) });
  if (!segment || segment.deletedAt) throw conflict("The campaign's segment was deleted.");

  // Claim the send first so a double click can never message twice.
  const [claimed] = await db
    .update(marketingCampaigns)
    .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(marketingCampaigns.id, campaignId), eq(marketingCampaigns.status, "APPROVED")))
    .returning();
  if (!claimed) throw conflict("This campaign is already being sent.");

  const limits = await getRule("marketing");
  const audience = (await db.execute(sql`
    select a.user_id from ${audienceQuery(shopId, normaliseRules(segment.rules))} a
    where a.consent
      and (select count(*) from campaign_recipients r join marketing_campaigns c on c.id = r.campaign_id
           where r.user_id = a.user_id and c.shop_id = ${shopId} and r.sent_at > now() - interval '7 days')
          < ${limits.perShopPerCustomerPerWeek}
      and (select count(*) from campaign_recipients r
           where r.user_id = a.user_id and r.sent_at > now() - interval '7 days')
          < ${limits.totalPerCustomerPerWeek}
    order by a.user_id`)) as unknown as { user_id: string }[];
  const [{ matched }] = (await db.execute(sql`
    select count(*)::int as matched from ${audienceQuery(shopId, normaliseRules(segment.rules))} a where a.consent`)) as unknown as {
    matched: number;
  }[];

  const recipients = audience.slice(0, current.maxRecipients).map((r) => r.user_id);
  const body = current.offerText ? `${current.message}\n${current.offerText}` : current.message;
  for (let i = 0; i < recipients.length; i += 500) {
    const chunk = recipients.slice(i, i + 500);
    await db.transaction(async (tx) => {
      await tx
        .insert(campaignRecipients)
        .values(chunk.map((userId) => ({ campaignId, userId, notificationKey: `campaign:${campaignId}:${userId}` })))
        .onConflictDoNothing();
      await tx
        .insert(notifications)
        .values(
          chunk.map((userId) => ({
            userId,
            type: NOTIFICATION_TYPES.MARKETING_CAMPAIGN,
            title: `${shop.name}: ${current.title}`,
            body,
            actionUrl: `/shops/${shop.slug}`,
            metadata: { campaignId, shopId },
            dedupeKey: `campaign:${campaignId}:${userId}`,
            sentAt: new Date(),
          })),
        )
        .onConflictDoNothing();
    });
  }

  const [campaign] = await db
    .update(marketingCampaigns)
    .set({ sentCount: recipients.length, suppressedCount: Math.max(0, n(matched) - recipients.length), updatedAt: new Date() })
    .where(eq(marketingCampaigns.id, campaignId))
    .returning();
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_SENT, "APPROVED", { sent: recipients.length, suppressed: campaign.suppressedCount });
  return campaign;
}

export interface CampaignStats {
  recipients: number;
  opened: number;
  converted: number;
  revenuePaise: number;
}

const statsSelect = sql`
  count(r.id)::int as recipients,
  count(r.id) filter (where exists (select 1 from notifications nt where nt.dedupe_key = r.notification_key and nt.read_at is not null))::int as opened,
  count(r.id) filter (where conv.first_order is not null)::int as converted,
  coalesce(sum(conv.value), 0)::bigint as revenue`;

const conversionJoin = sql`left join lateral (
    select min(o.created_at) as first_order, sum(o.total_paise) as value from orders o
    where o.user_id = r.user_id and o.shop_id = c.shop_id and o.created_at >= r.sent_at
      and o.created_at < r.sent_at + make_interval(days => c.attribution_days)
      and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')
  ) conv on true`;

async function statsFor(campaignIds: string[]): Promise<Map<string, CampaignStats>> {
  if (campaignIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    select c.id, ${statsSelect}
    from marketing_campaigns c join campaign_recipients r on r.campaign_id = c.id ${conversionJoin}
    where c.id in (${sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)})
    group by c.id`)) as unknown as Row[];
  return new Map(
    rows.map((r) => [
      String(r.id),
      { recipients: n(r.recipients), opened: n(r.opened), converted: n(r.converted), revenuePaise: n(r.revenue) },
    ]),
  );
}

const EMPTY_STATS: CampaignStats = { recipients: 0, opened: 0, converted: 0, revenuePaise: 0 };

export async function listShopCampaigns(shopId: string): Promise<(MarketingCampaign & { segmentName: string; stats: CampaignStats })[]> {
  const rows = await db
    .select({ campaign: marketingCampaigns, segmentName: customerSegments.name })
    .from(marketingCampaigns)
    .innerJoin(customerSegments, eq(marketingCampaigns.segmentId, customerSegments.id))
    .where(eq(marketingCampaigns.shopId, shopId))
    .orderBy(desc(marketingCampaigns.createdAt))
    .limit(100);
  const stats = await statsFor(rows.filter((r) => r.campaign.status === "SENT").map((r) => r.campaign.id));
  return rows.map((r) => ({ ...r.campaign, segmentName: r.segmentName, stats: stats.get(r.campaign.id) ?? EMPTY_STATS }));
}

/** Operations review queue: submitted first, then recent decisions and sends. */
export async function listCampaignsForReview(status?: CampaignStatus) {
  const rows = await db
    .select({ campaign: marketingCampaigns, shopName: shops.name, segmentName: customerSegments.name, segmentRules: customerSegments.rules })
    .from(marketingCampaigns)
    .innerJoin(shops, eq(marketingCampaigns.shopId, shops.id))
    .innerJoin(customerSegments, eq(marketingCampaigns.segmentId, customerSegments.id))
    .where(status ? eq(marketingCampaigns.status, status) : undefined)
    .orderBy(desc(marketingCampaigns.updatedAt))
    .limit(150);
  const stats = await statsFor(rows.filter((r) => r.campaign.status === "SENT").map((r) => r.campaign.id));
  return rows.map((r) => ({ ...r, stats: stats.get(r.campaign.id) ?? EMPTY_STATS }));
}
