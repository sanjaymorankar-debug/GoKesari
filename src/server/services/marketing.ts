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
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import {
  insertReturning,
  keepExisting,
  updateReturning,
} from "@/server/db/returning";
import { row as queryRow, rows as queryRows } from "@/server/db/raw";

export const MARKETING_LIMITS = {
  shopCampaignsPerWeek: 2,
  perShopPerCustomerPerWeek: 1,
  totalPerCustomerPerWeek: 3,
  maxRecipients: 5000,
} as const;

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
    const pins = [
      ...new Set(input.pincodes.map((p) => p.trim()).filter(Boolean)),
    ];
    if (pins.some((p) => !/^\d{6}$/.test(p)))
      throw validationFailed("PIN codes must be 6 digits.");
    if (pins.length > 50)
      throw validationFailed("At most 50 PIN codes per segment.");
    rules.pincodes = pins;
  }
  if (input.societyIds?.length)
    rules.societyIds = [...new Set(input.societyIds)].slice(0, 50);
  const whole = (
    value: number | undefined,
    label: string,
    min: number,
    max: number,
  ) => {
    if (value == null) return undefined;
    if (!Number.isInteger(value) || value < min || value > max)
      throw validationFailed(`${label} must be between ${min} and ${max}.`);
    return value;
  };
  rules.minOrders = whole(input.minOrders, "Minimum orders", 1, 1000);
  rules.orderedWithinDays = whole(
    input.orderedWithinDays,
    "Ordered within (days)",
    1,
    365,
  );
  rules.lapsedForDays = whole(
    input.lapsedForDays,
    "Not ordered for (days)",
    1,
    365,
  );
  rules.minSpendPaise = whole(
    input.minSpendPaise,
    "Minimum spend",
    1,
    100_000_000,
  );
  if (
    rules.orderedWithinDays &&
    rules.lapsedForDays &&
    rules.lapsedForDays >= rules.orderedWithinDays
  ) {
    throw validationFailed(
      "'Ordered within' must be longer than 'not ordered for' — otherwise nobody matches.",
    );
  }
  return Object.fromEntries(
    Object.entries(rules).filter(([, v]) => v !== undefined),
  ) as SegmentRules;
}

const placedByShop = (shopId: string) => sql`o.shop_id = ${shopId}
  and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')`;

const hasMarketingConsent = (
  userColumn: SQL,
) => sql`coalesce((select uc.granted from user_consents uc
  where uc.user_id = ${userColumn} and uc.consent_type = 'MARKETING_COMMUNICATIONS'
  order by uc.created_at desc limit 1), false)`;

/** The shop's customers matching `rules` (user id + consent), as a SQL subquery. */
function audienceQuery(shopId: string, rules: SegmentRules): SQL {
  const having: SQL[] = [sql`true`];
  if (rules.minOrders)
    having.push(
      sql`count(case when o.status in ('DELIVERED', 'DISPUTED') then 1 end) >= ${rules.minOrders}`,
    );
  if (rules.minSpendPaise) {
    having.push(
      sql`coalesce(sum(case when o.status in ('DELIVERED', 'DISPUTED') then o.total_paise end), 0) >= ${rules.minSpendPaise}`,
    );
  }
  if (rules.orderedWithinDays)
    having.push(
      sql`max(o.created_at) >= now() - interval ${rules.orderedWithinDays} day`,
    );
  if (rules.lapsedForDays)
    having.push(
      sql`max(o.created_at) < now() - interval ${rules.lapsedForDays} day`,
    );
  if (rules.pincodes?.length) {
    having.push(
      sql`max(o.delivery_address_snapshot->>'$.pincode' in (${sql.join(
        rules.pincodes.map((p) => sql`${p}`),
        sql`, `,
      )}))`,
    );
  }
  if (rules.societyIds?.length) {
    having.push(
      sql`max(o.society_id in (${sql.join(
        rules.societyIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`,
    );
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

export async function previewAudience(
  shopId: string,
  rules: SegmentRules,
): Promise<AudiencePreview> {
  const normalised = normaliseRules(rules);
  const summary = queryRow<Row>(
    await db.execute(sql`
    select CAST(count(*) AS SIGNED) as matched, CAST(count(case when a.consent then 1 end) AS SIGNED) as reachable
    from ${audienceQuery(shopId, normalised)} a`),
  );
  return { matched: n(summary?.matched), reachable: n(summary?.reachable) };
}

/** Headline customer counts for the shop's marketing page (never identities). */
export async function getShopCustomerOverview(shopId: string) {
  const row = queryRow<Row>(
    await db.execute(sql`
    select CAST(count(*) AS SIGNED) as customers,
      CAST(count(case when c.consent then 1 end) AS SIGNED) as consenting,
      CAST(count(case when c.delivered >= 2 then 1 end) AS SIGNED) as repeat,
      CAST(count(case when c.last_order < now() - interval 30 day then 1 end) AS SIGNED) as lapsed
    from (
      select o.user_id, ${hasMarketingConsent(sql`o.user_id`)} as consent,
        count(case when o.status in ('DELIVERED', 'DISPUTED') then 1 end) as delivered,
        max(o.created_at) as last_order
      from orders o where ${placedByShop(shopId)} group by o.user_id
    ) c`),
  );
  return {
    customers: n(row?.customers),
    consenting: n(row?.consenting),
    repeat: n(row?.repeat),
    lapsed: n(row?.lapsed),
  };
}

export async function listSegments(
  shopId: string,
): Promise<(CustomerSegment & AudiencePreview)[]> {
  const rows = await db
    .select()
    .from(customerSegments)
    .where(
      and(
        eq(customerSegments.shopId, shopId),
        isNull(customerSegments.deletedAt),
      ),
    )
    .orderBy(desc(customerSegments.createdAt));
  const result = [];
  for (const segment of rows) {
    result.push({
      ...segment,
      ...(await previewAudience(shopId, segment.rules)),
    });
  }
  return result;
}

export async function saveSegment(
  shopId: string,
  input: { id?: string | null; name: string; rules: SegmentRules },
  actor: Actor,
): Promise<CustomerSegment> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80)
    throw validationFailed("Give the segment a name (2–80 characters).");
  const rules = normaliseRules(input.rules);

  let saved: CustomerSegment;
  if (input.id) {
    const [updated] = await updateReturning(
      db,
      customerSegments,
      { name, rules, updatedAt: new Date() },
      and(
        eq(customerSegments.id, input.id),
        eq(customerSegments.shopId, shopId),
        isNull(customerSegments.deletedAt),
      ),
    );
    if (!updated) throw notFound("Segment");
    saved = updated;
  } else {
    [saved] = await insertReturning(db, customerSegments, {
      shopId,
      name,
      rules,
      createdBy: actor.id,
    });
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

export async function deleteSegment(
  shopId: string,
  segmentId: string,
  actor: Actor,
): Promise<void> {
  const [inUse] = await db
    .select({ id: marketingCampaigns.id })
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.segmentId, segmentId),
        inArray(marketingCampaigns.status, ["DRAFT", "SUBMITTED", "APPROVED"]),
      ),
    )
    .limit(1);
  if (inUse)
    throw conflict(
      "A campaign still uses this segment — cancel or send it first.",
    );
  const [deleted] = await updateReturning(
    db,
    customerSegments,
    { deletedAt: new Date() },
    and(
      eq(customerSegments.id, segmentId),
      eq(customerSegments.shopId, shopId),
      isNull(customerSegments.deletedAt),
    ),
  );
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

function validateCampaign(input: CampaignInput) {
  const title = input.title.trim();
  const message = input.message.trim();
  if (title.length < 3 || title.length > 80)
    throw validationFailed("Title must be 3–80 characters.");
  if (message.length < 10 || message.length > 500)
    throw validationFailed("Message must be 10–500 characters.");
  const offerText = input.offerText?.trim() || null;
  if (offerText && offerText.length > 120)
    throw validationFailed("Offer line must be at most 120 characters.");
  if (
    !Number.isInteger(input.maxRecipients) ||
    input.maxRecipients < 1 ||
    input.maxRecipients > MARKETING_LIMITS.maxRecipients
  ) {
    throw validationFailed(
      `Budget must be between 1 and ${MARKETING_LIMITS.maxRecipients} customers.`,
    );
  }
  const attributionDays = input.attributionDays ?? 7;
  if (
    !Number.isInteger(attributionDays) ||
    attributionDays < 1 ||
    attributionDays > 30
  ) {
    throw validationFailed("Attribution window must be 1–30 days.");
  }
  return {
    title,
    message,
    offerText,
    maxRecipients: input.maxRecipients,
    attributionDays,
  };
}

async function loadCampaign(
  campaignId: string,
  shopId?: string,
): Promise<MarketingCampaign> {
  const campaign = await db.query.marketingCampaigns.findFirst({
    where: eq(marketingCampaigns.id, campaignId),
  });
  if (!campaign || (shopId && campaign.shopId !== shopId))
    throw notFound("Campaign");
  return campaign;
}

async function audit(
  campaign: MarketingCampaign,
  actor: Actor,
  action: AuditAction,
  from: CampaignStatus | null,
  extra: Record<string, unknown> = {},
) {
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
  const values = validateCampaign(input);
  const segment = await db.query.customerSegments.findFirst({
    where: and(
      eq(customerSegments.id, input.segmentId),
      eq(customerSegments.shopId, shopId),
      isNull(customerSegments.deletedAt),
    ),
  });
  if (!segment) throw notFound("Segment");

  let campaign: MarketingCampaign;
  if (input.id) {
    const current = await loadCampaign(input.id, shopId);
    if (current.status !== "DRAFT" && current.status !== "REJECTED") {
      throw conflict("Only a draft or rejected campaign can be edited.");
    }
    [campaign] = await updateReturning(
      db,
      marketingCampaigns,
      {
        ...values,
        segmentId: segment.id,
        status: "DRAFT",
        rejectionReason: null,
        updatedAt: new Date(),
      },
      eq(marketingCampaigns.id, current.id),
    );
  } else {
    [campaign] = await insertReturning(db, marketingCampaigns, {
      ...values,
      shopId,
      segmentId: segment.id,
      createdBy: actor.id,
    });
  }
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_SAVED, null, {
    title: values.title,
    maxRecipients: values.maxRecipients,
  });
  return campaign;
}

/** Shop rate limit: campaigns submitted, approved or sent in the last 7 days. */
async function recentCampaignCount(shopId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`CAST(count(*) AS SIGNED)` })
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.shopId, shopId),
        inArray(marketingCampaigns.status, ["SUBMITTED", "APPROVED", "SENT"]),
        sql`coalesce(${marketingCampaigns.sentAt}, ${marketingCampaigns.submittedAt}) > now() - interval 7 day`,
      ),
    );
  return row.n;
}

export async function submitCampaign(
  shopId: string,
  campaignId: string,
  actor: Actor,
): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  if (current.status !== "DRAFT" && current.status !== "REJECTED")
    throw conflict("This campaign has already been submitted.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "APPROVED")
    throw conflict("Only an approved shop can run campaigns.");
  if (
    (await recentCampaignCount(shopId)) >= MARKETING_LIMITS.shopCampaignsPerWeek
  ) {
    throw conflict(
      `A shop can run at most ${MARKETING_LIMITS.shopCampaignsPerWeek} campaigns a week.`,
    );
  }
  const [campaign] = await updateReturning(
    db,
    marketingCampaigns,
    {
      status: "SUBMITTED",
      submittedAt: new Date(),
      rejectionReason: null,
      updatedAt: new Date(),
    },
    and(
      eq(marketingCampaigns.id, campaignId),
      inArray(marketingCampaigns.status, ["DRAFT", "REJECTED"]),
    ),
  );
  if (!campaign) throw conflict("This campaign has already been submitted.");
  await audit(
    campaign,
    actor,
    AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED,
    current.status,
  );
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
  if (current.status !== "SUBMITTED")
    throw conflict("Only a submitted campaign can be approved or rejected.");
  const trimmed = reason?.trim() || null;
  if (decision === "reject" && (!trimmed || trimmed.length < 3))
    throw validationFailed("Say why the campaign is rejected.");

  const [campaign] = await updateReturning(
    db,
    marketingCampaigns,
    {
      status: decision === "approve" ? "APPROVED" : "REJECTED",
      decidedBy: actor.id,
      decidedAt: new Date(),
      rejectionReason: decision === "reject" ? trimmed : null,
      updatedAt: new Date(),
    },
    and(
      eq(marketingCampaigns.id, campaignId),
      eq(marketingCampaigns.status, "SUBMITTED"),
    ),
  );
  if (!campaign) throw conflict("This campaign has already been decided.");
  await audit(
    campaign,
    actor,
    AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED,
    "SUBMITTED",
    { reason: trimmed },
  );

  const shop = await db.query.shops.findFirst({
    where: eq(shops.id, campaign.shopId),
  });
  if (shop) {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.CAMPAIGN_DECIDED,
      title:
        decision === "approve" ? "Campaign approved" : "Campaign needs changes",
      body:
        decision === "approve"
          ? `"${campaign.title}" is approved — send it from your marketing page.`
          : `"${campaign.title}" was not approved: ${trimmed}`,
      actionUrl: "/shop/marketing",
    });
  }
  return campaign;
}

export async function cancelCampaign(
  shopId: string,
  campaignId: string,
  actor: Actor,
): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  const [campaign] = await updateReturning(
    db,
    marketingCampaigns,
    { status: "CANCELLED", updatedAt: new Date() },
    and(
      eq(marketingCampaigns.id, campaignId),
      inArray(marketingCampaigns.status, [
        "DRAFT",
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
      ]),
    ),
  );
  if (!campaign)
    throw conflict("A sent or cancelled campaign cannot be cancelled.");
  await audit(
    campaign,
    actor,
    AUDIT_ACTIONS.CAMPAIGN_STATUS_CHANGED,
    current.status,
  );
  return campaign;
}

/**
 * Sends an APPROVED campaign: consenting customers of the segment, minus
 * anyone at a frequency cap, up to the budget. Each gets one in-app message.
 */
export async function sendCampaign(
  shopId: string,
  campaignId: string,
  actor: Actor,
): Promise<MarketingCampaign> {
  const current = await loadCampaign(campaignId, shopId);
  if (current.status !== "APPROVED")
    throw conflict("Only an approved campaign can be sent.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "APPROVED")
    throw forbidden("Only an approved shop can send campaigns.");
  const segment = await db.query.customerSegments.findFirst({
    where: eq(customerSegments.id, current.segmentId),
  });
  if (!segment || segment.deletedAt)
    throw conflict("The campaign's segment was deleted.");

  // Claim the send first so a double click can never message twice.
  const [claimed] = await updateReturning(
    db,
    marketingCampaigns,
    { status: "SENT", sentAt: new Date(), updatedAt: new Date() },
    and(
      eq(marketingCampaigns.id, campaignId),
      eq(marketingCampaigns.status, "APPROVED"),
    ),
  );
  if (!claimed) throw conflict("This campaign is already being sent.");

  const audience = queryRows<{ user_id: string }>(
    await db.execute(sql`
    select a.user_id from ${audienceQuery(shopId, normaliseRules(segment.rules))} a
    where a.consent
      and (select count(*) from campaign_recipients r join marketing_campaigns c on c.id = r.campaign_id
           where r.user_id = a.user_id and c.shop_id = ${shopId} and r.sent_at > now() - interval 7 day)
          < ${MARKETING_LIMITS.perShopPerCustomerPerWeek}
      and (select count(*) from campaign_recipients r
           where r.user_id = a.user_id and r.sent_at > now() - interval 7 day)
          < ${MARKETING_LIMITS.totalPerCustomerPerWeek}
    order by a.user_id`),
  );
  const matched = Number(
    queryRow<{ matched: number }>(
      await db.execute(sql`
    select CAST(count(*) AS SIGNED) as matched from ${audienceQuery(shopId, normaliseRules(segment.rules))} a where a.consent`),
    )?.matched ?? 0,
  );

  const recipients = audience
    .slice(0, current.maxRecipients)
    .map((r) => r.user_id);
  const body = current.offerText
    ? `${current.message}\n${current.offerText}`
    : current.message;
  for (let i = 0; i < recipients.length; i += 500) {
    const chunk = recipients.slice(i, i + 500);
    await db.transaction(async (tx) => {
      await tx
        .insert(campaignRecipients)
        .values(
          chunk.map((userId) => ({
            campaignId,
            userId,
            notificationKey: `campaign:${campaignId}:${userId}`,
          })),
        )
        .onDuplicateKeyUpdate({ set: keepExisting(campaignRecipients) });
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
        .onDuplicateKeyUpdate({ set: keepExisting(notifications) });
    });
  }

  const [campaign] = await updateReturning(
    db,
    marketingCampaigns,
    {
      sentCount: recipients.length,
      suppressedCount: Math.max(0, n(matched) - recipients.length),
      updatedAt: new Date(),
    },
    eq(marketingCampaigns.id, campaignId),
  );
  await audit(campaign, actor, AUDIT_ACTIONS.CAMPAIGN_SENT, "APPROVED", {
    sent: recipients.length,
    suppressed: campaign.suppressedCount,
  });
  return campaign;
}

export interface CampaignStats {
  recipients: number;
  opened: number;
  converted: number;
  revenuePaise: number;
}

// The attributed-orders rows. This was a LEFT JOIN LATERAL, which MySQL 8
// supports but MariaDB does not at all, so the two aggregates it produced
// become correlated scalar subqueries over the same predicate.
const attributedOrders = sql`from orders o
    where o.user_id = r.user_id and o.shop_id = c.shop_id and o.created_at >= r.sent_at
      and o.created_at < r.sent_at + interval c.attribution_days day
      and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')`;

const statsSelect = sql`
  CAST(count(r.id) AS SIGNED) as recipients,
  CAST(count(case when exists (select 1 from notifications nt where nt.dedupe_key = r.notification_key and nt.read_at is not null) then r.id end) AS SIGNED) as opened,
  CAST(count(case when (select min(o.created_at) ${attributedOrders}) is not null then r.id end) AS SIGNED) as converted,
  CAST(coalesce(sum((select sum(o.total_paise) ${attributedOrders})), 0) AS SIGNED) as revenue`;

async function statsFor(
  campaignIds: string[],
): Promise<Map<string, CampaignStats>> {
  if (campaignIds.length === 0) return new Map();
  const rows = queryRows<Row>(
    await db.execute(sql`
    select c.id, ${statsSelect}
    from marketing_campaigns c join campaign_recipients r on r.campaign_id = c.id
    where c.id in (${sql.join(
      campaignIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by c.id`),
  ) as unknown as Row[];
  return new Map(
    rows.map((r) => [
      String(r.id),
      {
        recipients: n(r.recipients),
        opened: n(r.opened),
        converted: n(r.converted),
        revenuePaise: n(r.revenue),
      },
    ]),
  );
}

const EMPTY_STATS: CampaignStats = {
  recipients: 0,
  opened: 0,
  converted: 0,
  revenuePaise: 0,
};

export async function listShopCampaigns(
  shopId: string,
): Promise<
  (MarketingCampaign & { segmentName: string; stats: CampaignStats })[]
> {
  const rows = await db
    .select({
      campaign: marketingCampaigns,
      segmentName: customerSegments.name,
    })
    .from(marketingCampaigns)
    .innerJoin(
      customerSegments,
      eq(marketingCampaigns.segmentId, customerSegments.id),
    )
    .where(eq(marketingCampaigns.shopId, shopId))
    .orderBy(desc(marketingCampaigns.createdAt))
    .limit(100);
  const stats = await statsFor(
    rows.filter((r) => r.campaign.status === "SENT").map((r) => r.campaign.id),
  );
  return rows.map((r) => ({
    ...r.campaign,
    segmentName: r.segmentName,
    stats: stats.get(r.campaign.id) ?? EMPTY_STATS,
  }));
}

/** Operations review queue: submitted first, then recent decisions and sends. */
export async function listCampaignsForReview(status?: CampaignStatus) {
  const rows = await db
    .select({
      campaign: marketingCampaigns,
      shopName: shops.name,
      segmentName: customerSegments.name,
      segmentRules: customerSegments.rules,
    })
    .from(marketingCampaigns)
    .innerJoin(shops, eq(marketingCampaigns.shopId, shops.id))
    .innerJoin(
      customerSegments,
      eq(marketingCampaigns.segmentId, customerSegments.id),
    )
    .where(status ? eq(marketingCampaigns.status, status) : undefined)
    .orderBy(desc(marketingCampaigns.updatedAt))
    .limit(150);
  const stats = await statsFor(
    rows.filter((r) => r.campaign.status === "SENT").map((r) => r.campaign.id),
  );
  return rows.map((r) => ({
    ...r,
    stats: stats.get(r.campaign.id) ?? EMPTY_STATS,
  }));
}
