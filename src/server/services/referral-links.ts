/**
 * Referral sharing (docs/referral-sharing-2026-11): what a referral link /r/<CODE> points at, the
 * share / click log, the deferred link after an app install, "My referrals" and the admin report.
 *
 * Additive only. Nothing here applies a code, rewards anyone or pays commission: a link only
 * pre-fills the code where the existing flows already take one (customer first-time setup through
 * the gk_ref cookie, Add my shop through ?ref=), and those flows keep every existing check —
 * self-referral, one referrer per account, the mandatory / optional setting, expired or closed codes.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { cleanShareCode, type ShareChannel } from "@/lib/referral-share";
import { db } from "@/server/db";
import {
  customerReferralCodes,
  customerReferrals,
  customerSignupReferrals,
  dealerCodes,
  dealerCommissionLedger,
  dealers,
  dealerSalespeople,
  franchiseCodes,
  referralCodes,
  referralLinkEvents,
  referralRedemptions,
  shopReferralCodes,
  shopReferrals,
  shopRegistrations,
  shops,
  users,
  type ReferralLinkEvent,
  type ReferralLinkKind,
} from "@/server/db/schema";
import { assertFranchiseCodeOpen } from "@/server/franchise/codes";
import { resolveUsableCode } from "./referrals";
import { getRule } from "./settings";
import { looksLikeShopCode, shopReferralRule } from "./shop-referrals";

/* ------------------------------------------------------------------ resolve */

export interface ReferralLinkTarget {
  code: string;
  kind: ReferralLinkKind;
  /** The account that owns the code, when known (self-referral check, "My referrals"). */
  referrerUserId: string | null;
  /** Shown as "Referred by <name>": a customer's first name, a shop's name, a dealer's business, an agent with the dealer. */
  referrerName: string | null;
  /** "Dealer", "Team lead", "Agent", "Franchise", "Shop", "Customer", "GoKesari" */
  level: string;
  /** Who the link signs up: a shop owner (Add my shop) or a customer (first-time setup). */
  audience: "shop-owner" | "customer";
  usable: boolean;
  outcome: "OK" | "CLOSED" | "EXPIRED" | "INVALID";
  /** The clear message for a code that can't be used. */
  message: string | null;
}

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || null;

/** Upper case, letters / digits / "-" / "_" — keeps the hyphen of GKD- / GKT- / GKA- / GKF- codes (the old /r/ route dropped it). */
export const normaliseLinkCode = cleanShareCode;

/**
 * What a code is. Order: a shop's code (SHOP…), a customer's code (GK…), then a code in referral_codes —
 * a dealer / team lead / agent code (dealer_codes), a franchise code (franchise_codes) or a code GoKesari
 * issued. Never throws for a bad code: it comes back with usable false and the message.
 */
export async function resolveReferralLink(raw: string): Promise<ReferralLinkTarget> {
  const code = normaliseLinkCode(raw);
  const invalid = (message = "This referral link isn't valid. Ask the person who shared it for a new one."): ReferralLinkTarget => ({
    code,
    kind: "UNKNOWN",
    referrerUserId: null,
    referrerName: null,
    level: "Unknown",
    audience: "customer",
    usable: false,
    outcome: "INVALID",
    message,
  });
  if (code.length < 4) return invalid();

  if (looksLikeShopCode(code)) {
    const [row] = await db
      .select({ name: shops.name, ownerId: shops.ownerId })
      .from(shopReferralCodes)
      .innerJoin(shops, eq(shops.id, shopReferralCodes.shopId))
      .where(eq(shopReferralCodes.code, code));
    if (row) {
      const on = (await shopReferralRule()).enabled;
      return {
        code,
        kind: "SHOP",
        referrerUserId: row.ownerId,
        referrerName: row.name,
        level: "Shop",
        audience: "shop-owner",
        usable: on,
        outcome: on ? "OK" : "CLOSED",
        message: on ? null : "Shop referral codes aren't open right now.",
      };
    }
  }

  const compact = code.replace(/[^A-Z0-9]/g, "");
  const [customer] = await db
    .select({ userId: customerReferralCodes.userId, name: users.name, deletedAt: users.deletedAt })
    .from(customerReferralCodes)
    .innerJoin(users, eq(users.id, customerReferralCodes.userId))
    .where(eq(customerReferralCodes.code, compact));
  if (customer) {
    if (customer.deletedAt) return invalid();
    return {
      code: compact,
      kind: "CUSTOMER",
      referrerUserId: customer.userId,
      referrerName: firstName(customer.name),
      level: "Customer",
      audience: "customer",
      usable: true,
      outcome: "OK",
      message: null,
    };
  }

  const [rc] = await db.select().from(referralCodes).where(eq(referralCodes.code, code));
  if (!rc) return invalid();
  const [dc] = await db
    .select({ dc: dealerCodes, dealerName: dealers.legalName, dealerUserId: dealers.userId, spName: dealerSalespeople.name, spUserId: dealerSalespeople.userId, spRole: dealerSalespeople.teamRole })
    .from(dealerCodes)
    .innerJoin(dealers, eq(dealers.id, dealerCodes.dealerId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerCodes.salespersonId))
    .where(eq(dealerCodes.referralCodeId, rc.id));
  const [fc] = dc
    ? []
    : await db
        .select({ ownerName: dealers.legalName, ownerUserId: dealers.userId })
        .from(franchiseCodes)
        .innerJoin(dealers, eq(dealers.id, franchiseCodes.ownerDealerId))
        .where(eq(franchiseCodes.referralCodeId, rc.id));

  let kind: ReferralLinkKind = "GOKESARI";
  let level = "GoKesari";
  let referrerUserId = rc.referrerUserId;
  let referrerName = rc.referrerName ?? rc.label;
  if (dc) {
    kind = "DEALER";
    if (dc.dc.salespersonId) {
      level = dc.spRole === "TEAM_LEAD" ? "Team lead" : "Agent";
      referrerUserId = dc.spUserId ?? null;
      referrerName = dc.spName ? `${dc.spName} (${dc.dealerName})` : dc.dealerName;
    } else {
      level = "Dealer";
      referrerUserId = dc.dealerUserId ?? rc.referrerUserId;
      referrerName = dc.dealerName;
    }
  } else if (fc) {
    kind = "FRANCHISE";
    level = "Franchise";
    referrerUserId = fc.ownerUserId ?? rc.referrerUserId;
    referrerName = fc.ownerName;
  }
  // Dealer, team lead, agent and franchise codes bring shops (the 20 / 4 / 3 % and franchise commission);
  // a code GoKesari issued keeps the old /r/ behaviour (customer sign-in), as before.
  const audience = kind === "GOKESARI" ? "customer" : "shop-owner";
  const base = { code, kind, referrerUserId, referrerName, level, audience } as const;
  try {
    await assertFranchiseCodeOpen(code);
    await resolveUsableCode(code);
    return { ...base, usable: true, outcome: "OK", message: null };
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      const expired = /expire/i.test(error.message);
      return { ...base, usable: false, outcome: expired ? "EXPIRED" : "CLOSED", message: `${error.message} Ask the person who shared it for a new link.` };
    }
    throw error;
  }
}

/** Where /r/<code> sends the visitor for a usable code. */
export function landingPathFor(target: ReferralLinkTarget, signedIn: boolean): string {
  if (target.audience === "shop-owner") return `/shop/register?ref=${encodeURIComponent(target.code)}`;
  return signedIn ? "/refer" : "/signin";
}

/* ------------------------------------------------------------------ log */

/** sha256 of the address with the site's secret: enough to match a click to an app first-open, never the address. */
export function hashIp(ip: string | null | undefined): string | null {
  const value = (ip ?? "").trim();
  if (!value) return null;
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "gokesari-referral-links";
  return createHash("sha256").update(`${secret}:${value}`).digest("hex");
}

export interface LogInput {
  code: string;
  kind: ReferralLinkKind;
  event: ReferralLinkEvent;
  channel?: ShareChannel | null;
  outcome?: string;
  referrerUserId?: string | null;
  actorUserId?: string | null;
  ip?: string | null;
  inApp?: boolean;
}

/** Best effort: a log row must never break a link or a share. */
export async function logReferralEvent(input: LogInput): Promise<string | null> {
  try {
    const [row] = await db
      .insert(referralLinkEvents)
      .values({
        code: normaliseLinkCode(input.code),
        kind: input.kind,
        event: input.event,
        channel: input.channel ?? null,
        outcome: input.outcome ?? "OK",
        referrerUserId: input.referrerUserId ?? null,
        actorUserId: input.actorUserId ?? null,
        ipHash: hashIp(input.ip),
        inApp: input.inApp ?? false,
      })
      .returning({ id: referralLinkEvents.id });
    return row?.id ?? null;
  } catch (error) {
    console.error("[referral-links] log failed", error);
    return null;
  }
}

export async function referralSharingOn(): Promise<boolean> {
  return (await getRule("referralSharing")).enabled;
}

/**
 * A share button: only for a code the signed-in person owns (their customer code, their shop's code,
 * their dealer / team-lead / agent / franchise code). Returns false for anyone else's code.
 */
export async function logShare(userId: string, rawCode: string, channel: ShareChannel): Promise<boolean> {
  const target = await resolveReferralLink(rawCode);
  if (target.kind === "UNKNOWN") return false;
  let mine = (await myReferralCodes(userId)).some((c) => c.code === target.code);
  if (!mine && target.kind === "DEALER") {
    // A main dealer shares his employees' (team leads', agents') codes from his portal too.
    const [row] = await db
      .select({ id: dealerCodes.id })
      .from(dealerCodes)
      .innerJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId))
      .innerJoin(dealers, eq(dealers.id, dealerCodes.dealerId))
      .where(and(eq(referralCodes.code, target.code), eq(dealers.userId, userId)));
    mine = Boolean(row);
  }
  if (!mine) return false;
  await logReferralEvent({ code: target.code, kind: target.kind, event: "SHARE", channel, referrerUserId: target.referrerUserId ?? userId, actorUserId: userId });
  return true;
}

/* ------------------------------------------------------------------ deferred link */

/**
 * A link opened in the phone's browser before the app was installed: the app's WebView has its own
 * cookies, so the gk_ref cookie is not there. The most recent usable click from the same network in the
 * last `deferredMatchHours` (rule referralSharing) is offered — pre-filled, never applied without the new
 * account's own Continue, and never a code of the account itself.
 */
export async function findDeferredReferral(ip: string | null | undefined, userId: string | null): Promise<{ eventId: string; target: ReferralLinkTarget } | null> {
  const ipHash = hashIp(ip);
  if (!ipHash) return null;
  const rule = await getRule("referralSharing");
  if (!rule.enabled) return null;
  const since = new Date(Date.now() - rule.deferredMatchHours * 3600_000);
  const [click] = await db
    .select()
    .from(referralLinkEvents)
    .where(and(eq(referralLinkEvents.event, "CLICK"), eq(referralLinkEvents.ipHash, ipHash), isNull(referralLinkEvents.claimedAt), eq(referralLinkEvents.outcome, "OK"), gte(referralLinkEvents.createdAt, since)))
    .orderBy(desc(referralLinkEvents.createdAt))
    .limit(1);
  if (!click) return null;
  const target = await resolveReferralLink(click.code);
  if (!target.usable || (userId && target.referrerUserId === userId)) return null;
  return { eventId: click.id, target };
}

/** Marks the click as offered to this account (once), and logs the CLAIM. */
export async function claimDeferredReferral(eventId: string, userId: string, target: ReferralLinkTarget, ip: string | null, inApp: boolean): Promise<void> {
  try {
    const updated = await db
      .update(referralLinkEvents)
      .set({ claimedByUserId: userId, claimedAt: new Date() })
      .where(and(eq(referralLinkEvents.id, eventId), isNull(referralLinkEvents.claimedAt)))
      .returning({ id: referralLinkEvents.id });
    if (updated.length) {
      await logReferralEvent({ code: target.code, kind: target.kind, event: "CLAIM", referrerUserId: target.referrerUserId, actorUserId: userId, ip, inApp });
    }
  } catch (error) {
    console.error("[referral-links] claim failed", error);
  }
}

/* ------------------------------------------------------------------ my referrals */

export interface MyCode {
  code: string;
  kind: ReferralLinkKind;
  level: string;
  audience: "shop-owner" | "customer";
  /** dealer_codes / franchise: whose commission the code earns. */
  dealerId?: string | null;
  salespersonId?: string | null;
  referralCodeId?: string | null;
  shopId?: string | null;
}

/** Every code the account owns: its customer code (when it has one), its shops' codes, its dealer / team / franchise codes. */
export async function myReferralCodes(userId: string): Promise<MyCode[]> {
  // docs/flows-v3/wave4.md F12 (flag flow_f12): every account has its own codes to share — the customer code, and
  // a code for each live shop (while shop referrals are on); dealer, team and franchise codes come with approval.
  if (await (await import("@/server/flows/wave4")).flow4On("flow_f12")) await ensureOwnCodes(userId).catch((e: unknown) => console.error("[referral-links] codes not completed", userId, e));
  const out: MyCode[] = [];
  const [cust] = await db.select().from(customerReferralCodes).where(eq(customerReferralCodes.userId, userId));
  if (cust) out.push({ code: cust.code, kind: "CUSTOMER", level: "Customer", audience: "customer" });
  const shopCodes = await db
    .select({ code: shopReferralCodes.code, shopId: shops.id })
    .from(shopReferralCodes)
    .innerJoin(shops, eq(shops.id, shopReferralCodes.shopId))
    .where(eq(shops.ownerId, userId));
  for (const s of shopCodes) out.push({ code: s.code, kind: "SHOP", level: "Shop", audience: "shop-owner", shopId: s.shopId });
  const dealerRows = await db
    .select({ code: referralCodes.code, rcId: referralCodes.id, dealerId: dealerCodes.dealerId, spId: dealerCodes.salespersonId, spRole: dealerSalespeople.teamRole, status: dealerCodes.status })
    .from(dealerCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId))
    .innerJoin(dealers, eq(dealers.id, dealerCodes.dealerId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerCodes.salespersonId))
    .where(and(eq(dealerCodes.status, "ACTIVE"), sql`((${dealerCodes.salespersonId} IS NULL AND ${dealers.userId} = ${userId}) OR ${dealerSalespeople.userId} = ${userId})`));
  for (const d of dealerRows) {
    out.push({
      code: d.code,
      kind: "DEALER",
      level: d.spId ? (d.spRole === "TEAM_LEAD" ? "Team lead" : "Agent") : "Dealer",
      audience: "shop-owner",
      dealerId: d.dealerId,
      salespersonId: d.spId,
      referralCodeId: d.rcId,
    });
  }
  const fr = await db
    .select({ code: referralCodes.code, rcId: referralCodes.id, dealerId: franchiseCodes.ownerDealerId })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .innerJoin(dealers, eq(dealers.id, franchiseCodes.ownerDealerId))
    .where(and(eq(dealers.userId, userId), eq(franchiseCodes.status, "ACTIVE")));
  for (const f of fr) out.push({ code: f.code, kind: "FRANCHISE", level: "Franchise", audience: "shop-owner", dealerId: f.dealerId, referralCodeId: f.rcId });
  return out;
}

/** F12: creates the account's missing customer code and live shops' codes (each made once; safe to repeat). */
export async function ensureOwnCodes(userId: string): Promise<void> {
  const [user] = await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId));
  if (!user || user.deletedAt) return;
  await (await import("./customer-referrals")).getOrCreateReferralCode(userId);
  const live = await db.select({ id: shops.id }).from(shops).where(and(eq(shops.ownerId, userId), eq(shops.status, "APPROVED"), isNull(shops.deletedAt)));
  if (!live.length) return;
  const { getOrCreateShopReferralCode } = await import("./shop-referrals");
  for (const s of live) await getOrCreateShopReferralCode(s.id);
}

export interface CodeStats {
  code: string;
  kind: ReferralLinkKind;
  level: string;
  shares: number;
  sharesByChannel: Record<string, number>;
  clicks: number;
  signups: number;
  pending: number;
  /** Paise: wallet rewards (customer / shop) or commission credited to this code's payee (dealer / franchise). */
  earnedPaise: number;
  /** Paise of commission not yet earned (pending / on hold), dealer and franchise codes. */
  pendingPaise: number;
}

async function eventCounts(codes: string[]) {
  if (codes.length === 0) return [];
  return db
    .select({ code: referralLinkEvents.code, event: referralLinkEvents.event, channel: referralLinkEvents.channel, n: sql<number>`count(*)::int` })
    .from(referralLinkEvents)
    .where(inArray(referralLinkEvents.code, codes))
    .groupBy(referralLinkEvents.code, referralLinkEvents.event, referralLinkEvents.channel);
}

/** Signups, pending and earned come from the existing referral tables — the same numbers the rewards and commission use. */
async function outcomeFor(c: MyCode, userId: string): Promise<Pick<CodeStats, "signups" | "pending" | "earnedPaise" | "pendingPaise">> {
  if (c.kind === "CUSTOMER") {
    const rows = await db
      .select({ status: customerReferrals.status, n: sql<number>`count(*)::int`, earned: sql<number>`coalesce(sum(${customerReferrals.referrerRewardPaise}), 0)::int` })
      .from(customerReferrals)
      .where(eq(customerReferrals.referrerUserId, userId))
      .groupBy(customerReferrals.status);
    const signups = rows.reduce((a, r) => a + r.n, 0);
    return {
      signups,
      pending: rows.find((r) => r.status === "PENDING")?.n ?? 0,
      earnedPaise: rows.find((r) => r.status === "REWARDED")?.earned ?? 0,
      pendingPaise: 0,
    };
  }
  if (c.kind === "SHOP" && c.shopId) {
    const rows = await db
      .select({ status: shopReferrals.status, n: sql<number>`count(*)::int`, earned: sql<number>`coalesce(sum(${shopReferrals.referrerRewardPaise}), 0)::int` })
      .from(shopReferrals)
      .where(eq(shopReferrals.referrerShopId, c.shopId))
      .groupBy(shopReferrals.status);
    return {
      signups: rows.reduce((a, r) => a + r.n, 0),
      pending: rows.find((r) => r.status === "PENDING")?.n ?? 0,
      earnedPaise: rows.find((r) => r.status === "REWARDED")?.earned ?? 0,
      pendingPaise: 0,
    };
  }
  if ((c.kind === "DEALER" || c.kind === "FRANCHISE") && c.referralCodeId) {
    const [{ shopsIn }] = await db.select({ shopsIn: sql<number>`count(*)::int` }).from(referralRedemptions).where(eq(referralRedemptions.referralCodeId, c.referralCodeId));
    const [{ held }] = await db
      .select({ held: sql<number>`count(*)::int` })
      .from(shopRegistrations)
      .where(and(eq(shopRegistrations.referralCodeId, c.referralCodeId), eq(shopRegistrations.status, "PENDING_PAYMENT")));
    const [{ customersIn }] = await db.select({ customersIn: sql<number>`count(*)::int` }).from(customerSignupReferrals).where(eq(customerSignupReferrals.referralCodeId, c.referralCodeId));
    let earnedPaise = 0;
    let pendingPaise = 0;
    if (c.dealerId) {
      const payee: SQL = c.salespersonId ? eq(dealerCommissionLedger.payeeMemberId, c.salespersonId) : isNull(dealerCommissionLedger.payeeMemberId);
      const rows = await db
        .select({ status: dealerCommissionLedger.status, sum: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::int` })
        .from(dealerCommissionLedger)
        .where(and(eq(dealerCommissionLedger.dealerId, c.dealerId), payee))
        .groupBy(dealerCommissionLedger.status);
      for (const r of rows) {
        if (r.status === "PENDING" || r.status === "ON_HOLD") pendingPaise += r.sum;
        else if (r.status === "EARNED" || r.status === "APPROVED" || r.status === "PAID") earnedPaise += r.sum;
      }
    }
    return { signups: shopsIn + customersIn, pending: held, earnedPaise, pendingPaise };
  }
  return { signups: 0, pending: 0, earnedPaise: 0, pendingPaise: 0 };
}

export async function myReferralStats(userId: string): Promise<CodeStats[]> {
  const codes = await myReferralCodes(userId);
  const counts = await eventCounts(codes.map((c) => c.code));
  const out: CodeStats[] = [];
  for (const c of codes) {
    const mine = counts.filter((r) => r.code === c.code);
    const sharesByChannel: Record<string, number> = {};
    for (const r of mine.filter((r) => r.event === "SHARE")) sharesByChannel[r.channel ?? "other"] = (sharesByChannel[r.channel ?? "other"] ?? 0) + r.n;
    out.push({
      code: c.code,
      kind: c.kind,
      level: c.level,
      shares: mine.filter((r) => r.event === "SHARE").reduce((a, r) => a + r.n, 0),
      sharesByChannel,
      clicks: mine.filter((r) => r.event === "CLICK").reduce((a, r) => a + r.n, 0),
      ...(await outcomeFor(c, userId)),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ admin report */

export interface ReportFilter {
  /** A code, or part of a referrer's name / e-mail. */
  referrer?: string | null;
  kind?: ReferralLinkKind | null;
  channel?: string | null;
  /** IST dates, YYYY-MM-DD, inclusive. */
  from?: string | null;
  to?: string | null;
}

/** IST midnight of a YYYY-MM-DD date as an instant. */
export function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

export async function referralReport(filter: ReportFilter) {
  const where: SQL[] = [];
  if (filter.kind) where.push(eq(referralLinkEvents.kind, filter.kind));
  if (filter.channel) where.push(eq(referralLinkEvents.channel, filter.channel));
  if (filter.from && /^\d{4}-\d{2}-\d{2}$/.test(filter.from)) where.push(gte(referralLinkEvents.createdAt, istDayStart(filter.from)));
  if (filter.to && /^\d{4}-\d{2}-\d{2}$/.test(filter.to)) where.push(lt(referralLinkEvents.createdAt, new Date(istDayStart(filter.to).getTime() + 86_400_000)));
  const q = (filter.referrer ?? "").trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, "")}%`;
    where.push(sql`(${referralLinkEvents.code} ILIKE ${like} OR ${users.name} ILIKE ${like} OR ${users.email} ILIKE ${like})`);
  }
  const rows = await db
    .select({
      code: referralLinkEvents.code,
      kind: referralLinkEvents.kind,
      referrerUserId: referralLinkEvents.referrerUserId,
      referrerName: users.name,
      shares: sql<number>`count(*) FILTER (WHERE ${referralLinkEvents.event} = 'SHARE')::int`,
      clicks: sql<number>`count(*) FILTER (WHERE ${referralLinkEvents.event} = 'CLICK')::int`,
      blocked: sql<number>`count(*) FILTER (WHERE ${referralLinkEvents.event} = 'CLICK' AND ${referralLinkEvents.outcome} <> 'OK')::int`,
      appOpens: sql<number>`count(*) FILTER (WHERE ${referralLinkEvents.event} = 'APP_OPEN')::int`,
      claims: sql<number>`count(*) FILTER (WHERE ${referralLinkEvents.event} = 'CLAIM')::int`,
      last: sql<Date>`max(${referralLinkEvents.createdAt})`,
    })
    .from(referralLinkEvents)
    .leftJoin(users, eq(users.id, referralLinkEvents.referrerUserId))
    .where(where.length ? and(...where) : undefined)
    .groupBy(referralLinkEvents.code, referralLinkEvents.kind, referralLinkEvents.referrerUserId, users.name)
    .orderBy(desc(sql`max(${referralLinkEvents.createdAt})`))
    .limit(500);
  const recent = await db
    .select({ e: referralLinkEvents, referrerName: users.name })
    .from(referralLinkEvents)
    .leftJoin(users, eq(users.id, referralLinkEvents.referrerUserId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(referralLinkEvents.createdAt))
    .limit(200);
  return { rows: rows.map((r) => ({ ...r, last: r.last ? new Date(r.last) : null })), recent };
}
