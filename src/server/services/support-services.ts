/**
 * Paid Support Services (docs/dealer-programme, GKS-SP-001), behind the flag
 * paid_support_services_enabled (per district, from the shop's PIN code).
 *
 *   GENERAL         account, registration, orders, payments, technical issues
 *   PRODUCT_UPLOAD  our team adds products, photos and descriptions
 *   PRICE_UPDATE    our team updates prices, MRP overrides, discounts, schemes
 *
 * Charges are the admin's (versioned; a request keeps the version it was
 * priced with): FREE, PER_REQUEST, PER_ITEM or PER_BATCH (e.g. per 50
 * products), GST on top where it applies, and a free number of requests per
 * shop per month. Shops on the managed inventory & billing plan (billed the
 * billing-management fee in the last 45 days) get product upload and price
 * update free while the setting says so — never charged twice.
 *
 * Flow: the owner (or the dealer who brought the shop) sees the price for the
 * quantity before submitting; pays from the shop wallet (owner only) or online
 * (the gateway's signed webhook confirms it); a free request needs no payment.
 * Once paid, a help-desk ticket is opened (category "Other", the help desk's
 * statuses, SLA, notifications and reopen as for any ticket), with the files.
 * A request cancelled before work starts is refunded by the admin's percentage
 * (to the wallet, or to the card / UPI it was paid with); after work starts only
 * an admin refunds. Every paid request has a receipt (number, base, GST,
 * total). Only ADMIN changes charges and settings.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, count, desc, eq, gte, inArray, lte, or, isNull } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { closeWithdrawnTicket, createTicket, type Actor as TicketActor } from "@/server/aftercare/support-tickets";
import { db } from "@/server/db";
import {
  dealers,
  platformInvoiceLines,
  platformInvoices,
  shopAttributions,
  shops,
  supportServiceCharges,
  supportServiceFiles,
  supportServiceRequests,
  supportServiceSettings,
  supportServiceTypes,
  supportTicketAttachments,
  supportTickets,
  users,
  type SupportServiceCharge,
  type SupportServiceRequest,
  type SupportServiceSettings,
  type UserRole,
} from "@/server/db/schema";
import { createPaymentIntent, refundPaymentIntent, type PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { flagCoversDistrict, getFeatureFlag } from "./feature-flags";
import { districtCodeForPincode } from "./geo-areas";
import { applyShopWalletEntry } from "./shop-wallet";

interface Actor {
  id: string;
  role: UserRole;
  email?: string | null;
  name?: string | null;
}

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

/* ============================================================= the catalogue */

export async function getSupportSettings(): Promise<SupportServiceSettings> {
  const [row] = await db.select().from(supportServiceSettings).where(eq(supportServiceSettings.id, "default"));
  return row ?? { id: "default", refundPercentBeforeWork: 100, freeForManagedBilling: true, updatedBy: null, updatedAt: new Date(0) };
}

/** The charge in force for a service today. */
export async function currentCharge(serviceKey: string): Promise<SupportServiceCharge | null> {
  const d = today();
  const [row] = await db
    .select()
    .from(supportServiceCharges)
    .where(
      and(
        eq(supportServiceCharges.serviceKey, serviceKey),
        eq(supportServiceCharges.status, "ACTIVE"),
        lte(supportServiceCharges.effectiveFrom, d),
        or(isNull(supportServiceCharges.effectiveTo), gte(supportServiceCharges.effectiveTo, d)),
      ),
    )
    .orderBy(desc(supportServiceCharges.version))
    .limit(1);
  return row ?? null;
}

export async function listSupportServices() {
  const types = await db.select().from(supportServiceTypes).where(eq(supportServiceTypes.status, "ACTIVE")).orderBy(supportServiceTypes.sortOrder);
  return Promise.all(types.map(async (t) => ({ ...t, charge: await currentCharge(t.key) })));
}

/* ================================================================ access */

/** Is the paid support services page on for this shop? */
export async function supportServicesOn(shopId: string): Promise<boolean> {
  const flag = await getFeatureFlag("paid_support_services_enabled");
  if (!flag.enabled) return false;
  const [shop] = await db.select({ pincode: shops.pincode }).from(shops).where(eq(shops.id, shopId));
  return Boolean(shop) && flagCoversDistrict(flag, await districtCodeForPincode(shop.pincode));
}

/**
 * Who may ask for a shop: its owner, or an approved dealer the shop is
 * attributed to. Anyone else: "not found" (no hint that the shop exists).
 */
export async function requesterFor(shopId: string, actor: Actor): Promise<{ kind: "OWNER" | "DEALER"; dealerId: string | null }> {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId === actor.id) return { kind: "OWNER", dealerId: null };
  const [mine] = await db
    .select({ dealerId: dealers.id })
    .from(shopAttributions)
    .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
    .where(and(eq(shopAttributions.shopId, shopId), eq(shopAttributions.status, "ACTIVE"), eq(dealers.userId, actor.id), eq(dealers.status, "APPROVED")));
  if (mine) return { kind: "DEALER", dealerId: mine.dealerId };
  throw notFound("Shop");
}

/* ================================================================= pricing */

export interface SupportQuote {
  serviceKey: string;
  chargeId: string;
  chargeVersion: number;
  quantity: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  freeReason: "FREE_SERVICE" | "MONTHLY_QUOTA" | "MANAGED_BILLING" | null;
  explanation: string;
  quotaLeft: number;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The base price for a quantity under a charge (before GST). */
export function priceFor(charge: Pick<SupportServiceCharge, "chargeModel" | "amountPaise" | "batchSize">, quantity: number): number {
  switch (charge.chargeModel) {
    case "FREE":
      return 0;
    case "PER_REQUEST":
      return charge.amountPaise;
    case "PER_ITEM":
      return charge.amountPaise * quantity;
    case "PER_BATCH":
      return charge.amountPaise * Math.ceil(quantity / (charge.batchSize ?? 1));
  }
}

async function onManagedBilling(shopId: string): Promise<boolean> {
  const since = new Date(Date.now() - 45 * 86_400_000);
  const [row] = await db
    .select({ n: count() })
    .from(platformInvoiceLines)
    .innerJoin(platformInvoices, eq(platformInvoices.id, platformInvoiceLines.invoiceId))
    .where(and(eq(platformInvoices.shopId, shopId), eq(platformInvoiceLines.feeType, "BILLING_MANAGEMENT"), gte(platformInvoices.issuedAt, since)));
  return (row?.n ?? 0) > 0;
}

async function usedThisMonth(shopId: string, serviceKey: string): Promise<number> {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [row] = await db
    .select({ n: count() })
    .from(supportServiceRequests)
    .where(
      and(
        eq(supportServiceRequests.shopId, shopId),
        eq(supportServiceRequests.serviceKey, serviceKey),
        eq(supportServiceRequests.freeReason, "MONTHLY_QUOTA"),
        inArray(supportServiceRequests.status, ["PAID"]),
        gte(supportServiceRequests.createdAt, start),
      ),
    );
  return row?.n ?? 0;
}

/** The price the shop is shown before it submits (and the price it is charged). */
export async function quoteSupportService(shopId: string, serviceKey: string, quantity: number): Promise<SupportQuote> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw validationFailed("Quantity: 1 to 100,000.", { fields: { quantity: "1 to 100,000." } });
  const [type] = await db.select().from(supportServiceTypes).where(eq(supportServiceTypes.key, serviceKey));
  if (!type || type.status !== "ACTIVE") throw notFound("Service");
  const charge = await currentCharge(serviceKey);
  if (!charge) throw conflict("This service has no price set yet. Please contact GoKesari.");
  const qty = type.unitLabel ? quantity : 1;
  const used = await usedThisMonth(shopId, serviceKey);
  const quotaLeft = Math.max(0, charge.freeQuotaPerMonth - used);
  const settings = await getSupportSettings();
  let freeReason: SupportQuote["freeReason"] = null;
  if (charge.chargeModel === "FREE" || charge.amountPaise === 0) freeReason = "FREE_SERVICE";
  else if (settings.freeForManagedBilling && serviceKey !== "GENERAL" && (await onManagedBilling(shopId))) freeReason = "MANAGED_BILLING";
  else if (quotaLeft > 0) freeReason = "MONTHLY_QUOTA";
  const base = freeReason ? 0 : priceFor(charge, qty);
  const gst = charge.gstApplicable ? Math.round((base * charge.gstRateBp) / 10_000) : 0;
  const unit =
    charge.chargeModel === "PER_BATCH"
      ? `${rs(charge.amountPaise)} per ${charge.batchSize} ${type.unitLabel ?? "items"} (${Math.ceil(qty / (charge.batchSize ?? 1))} × ${rs(charge.amountPaise)})`
      : charge.chargeModel === "PER_ITEM"
        ? `${rs(charge.amountPaise)} per ${type.unitLabel?.replace(/s$/, "") ?? "item"} × ${qty}`
        : charge.chargeModel === "PER_REQUEST"
          ? `${rs(charge.amountPaise)} per request`
          : "free";
  const explanation =
    freeReason === "FREE_SERVICE"
      ? "Free."
      : freeReason === "MANAGED_BILLING"
        ? "Free — included in your managed inventory & billing plan."
        : freeReason === "MONTHLY_QUOTA"
          ? `Free — included in your ${charge.freeQuotaPerMonth} free request(s) this month.`
          : `${unit}${gst ? ` + GST ${charge.gstRateBp / 100}% ${rs(gst)}` : ""} = ${rs(base + gst)}.`;
  return { serviceKey, chargeId: charge.id, chargeVersion: charge.version, quantity: qty, basePaise: base, gstPaise: gst, totalPaise: base + gst, freeReason, explanation, quotaLeft };
}

/* ================================================================ requests */

function receiptNumber(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SSR-${d}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function checkFile(f: { name: string; bytes: Buffer }): string {
  if (f.bytes.length === 0) throw validationFailed(`${f.name} is empty.`);
  if (f.bytes.length > MAX_FILE_BYTES) throw validationFailed(`${f.name} is larger than 10 MB.`);
  const head = f.bytes.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF") return "image/webp";
  if (head[0] === 0x50 && head[1] === 0x4b && /\.(xlsx|xlsm)$/i.test(f.name)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.csv$/i.test(f.name) && !f.bytes.subarray(0, 4096).includes(0)) return "text/csv";
  throw validationFailed(`${f.name}: upload Excel (.xlsx), CSV, PDF or photos (JPEG, PNG, WebP).`);
}

export interface CreateRequestInput {
  shopId: string;
  serviceKey: string;
  quantity: number;
  description: string;
  files?: { name: string; bytes: Buffer }[];
}

/**
 * Creates the request at the quoted price. A free one is paid at once and
 * its ticket opened; a priced one waits for payment.
 */
export async function createSupportRequest(input: CreateRequestInput, actor: Actor): Promise<SupportServiceRequest> {
  if (!(await supportServicesOn(input.shopId))) throw new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: "paid_support_services_enabled" });
  const who = await requesterFor(input.shopId, actor);
  const description = input.description.trim().slice(0, 4000);
  if (description.length < 10) throw validationFailed("Describe what you need (at least 10 characters).", { fields: { description: "Too short." } });
  const files = input.files ?? [];
  if (files.length > MAX_FILES) throw validationFailed(`At most ${MAX_FILES} files.`);
  const types = files.map(checkFile);
  const quote = await quoteSupportService(input.shopId, input.serviceKey, input.quantity);
  const free = quote.totalPaise === 0;
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(supportServiceRequests)
      .values({
        receiptNumber: receiptNumber(),
        shopId: input.shopId,
        requestedBy: actor.id,
        dealerId: who.dealerId,
        serviceKey: input.serviceKey,
        chargeId: quote.chargeId,
        quantity: quote.quantity,
        description,
        basePaise: quote.basePaise,
        gstPaise: quote.gstPaise,
        totalPaise: quote.totalPaise,
        freeReason: quote.freeReason,
        status: free ? "PAID" : "AWAITING_PAYMENT",
        paymentMethod: free ? "FREE" : null,
        paidAt: free ? new Date() : null,
      })
      .returning();
    for (const [i, f] of files.entries()) {
      await tx.insert(supportServiceFiles).values({ requestId: inserted[0].id, fileName: f.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120), mimeType: types[i], sizeBytes: f.bytes.length, content: f.bytes });
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SUPPORT_SERVICE_REQUESTED,
        entityType: "support_service_request",
        entityId: inserted[0].id,
        newValue: { shopId: input.shopId, serviceKey: input.serviceKey, quantity: quote.quantity, totalPaise: quote.totalPaise, freeReason: quote.freeReason, chargeVersion: quote.chargeVersion, by: who.kind },
      },
      tx,
    );
    return inserted;
  });
  if (free) await ensureTicket(row.id);
  return (await getRequest(row.id))!;
}

export async function getRequest(id: string): Promise<SupportServiceRequest | null> {
  const [row] = await db.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, id));
  return row ?? null;
}

async function ownRequest(id: string, actor: Actor): Promise<SupportServiceRequest> {
  const req = await getRequest(id);
  if (!req) throw notFound("Request");
  if (req.requestedBy !== actor.id) {
    // The shop's owner sees a request a dealer raised for the shop, too.
    const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, req.shopId));
    if (shop?.ownerId !== actor.id) throw notFound("Request");
  }
  return req;
}

/**
 * Pays from the shop's prepaid wallet (the owner only). Not enough balance:
 * 402 with the shortfall — top up or pay online; nothing is created.
 */
export async function payFromWallet(requestId: string, actor: Actor): Promise<SupportServiceRequest> {
  const req = await ownRequest(requestId, actor);
  if (req.status !== "AWAITING_PAYMENT") throw conflict("This request is not waiting for payment.");
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, req.shopId));
  if (shop?.ownerId !== actor.id) throw forbidden("Only the shop's owner can pay from the shop wallet.");
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, requestId)).for("update");
    if (locked.status !== "AWAITING_PAYMENT") throw conflict("This request is not waiting for payment.");
    const entry = await applyShopWalletEntry(
      { shopId: req.shopId, type: "MANUAL_DEBIT", amountPaise: req.totalPaise, reason: `Support service ${req.serviceKey.toLowerCase().replace("_", " ")} (${req.receiptNumber})`, idempotencyKey: `support-service:${req.id}`, createdBy: actor.id },
      tx,
    );
    await tx
      .update(supportServiceRequests)
      .set({ status: "PAID", paymentMethod: "WALLET", walletReference: entry.transaction.id, paidAt: new Date(), updatedAt: new Date() })
      .where(eq(supportServiceRequests.id, requestId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_SERVICE_PAID, entityType: "support_service_request", entityId: requestId, newValue: { method: "WALLET", totalPaise: req.totalPaise } }, tx);
  });
  await ensureTicket(requestId);
  return (await getRequest(requestId))!;
}

/** Pays online (UPI / card): a gateway checkout; the request is paid only when the signed webhook confirms it. */
export async function payOnline(requestId: string, actor: Actor) {
  const req = await ownRequest(requestId, actor);
  if (req.status !== "AWAITING_PAYMENT") throw conflict("This request is not waiting for payment.");
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const created = await createPaymentIntent({
    purpose: "SUPPORT_SERVICE",
    referenceId: req.id,
    userId: actor.id,
    amountPaise: req.totalPaise,
    customer: { id: actor.id, name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description: `GoKesari support service ${req.receiptNumber}`,
    idempotencyKey: `support-service:${req.id}`,
    mode: "CHECKOUT",
    returnPath: "/shop/support-services",
  });
  await db.update(supportServiceRequests).set({ paymentIntentId: created.intent.id, updatedAt: new Date() }).where(eq(supportServiceRequests.id, req.id));
  return created;
}

/**
 * The gateway confirmed the payment (purpose handler, inside the capture
 * transaction): the request is paid when the amount is right; its ticket is
 * opened after the commit.
 */
export async function onSupportServicePaymentCaptured(intent: PaymentIntentRef, client: typeof db): Promise<void> {
  const [req] = await client.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, intent.referenceId)).for("update");
  if (!req) return;
  if (req.status !== "AWAITING_PAYMENT") return;
  if (intent.amountPaise !== req.totalPaise) {
    await recordAudit({ action: AUDIT_ACTIONS.SUPPORT_SERVICE_PAID, entityType: "support_service_request", entityId: req.id, newValue: { problem: "amount_mismatch", intentAmount: intent.amountPaise, totalPaise: req.totalPaise } }, client);
    return;
  }
  await client
    .update(supportServiceRequests)
    .set({ status: "PAID", paymentMethod: "ONLINE", paymentIntentId: intent.id, paidAt: new Date(), updatedAt: new Date() })
    .where(eq(supportServiceRequests.id, req.id));
  await recordAudit({ action: AUDIT_ACTIONS.SUPPORT_SERVICE_PAID, entityType: "support_service_request", entityId: req.id, newValue: { method: "ONLINE", intentId: intent.id, totalPaise: req.totalPaise } }, client);
  const after = () => void ensureTicket(req.id).catch((e) => console.error("[support-services] ticket after payment failed", req.id, e));
  if (client === db) after();
  else setTimeout(after, 2_000).unref?.();
}

const SERVICE_LABEL: Record<string, string> = { GENERAL: "General support", PRODUCT_UPLOAD: "Product upload", PRICE_UPDATE: "Price update" };

/**
 * Opens the help-desk ticket of a paid request, once (the request row is
 * locked while the ticket is made), and copies its files to the ticket. The
 * help desk switched off: the request stays paid without a ticket and staff
 * see it in the admin list.
 */
export async function ensureTicket(requestId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, requestId)).for("update");
    if (!req || req.status !== "PAID") return null;
    if (req.ticketId) return req.ticketId;
    const [requester] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, req.requestedBy));
    const [shop] = await tx.select({ name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, req.shopId));
    if (!requester || !shop) return null;
    const isOwner = shop.ownerId === requester.id;
    let ticketId: string;
    try {
      const ticket = await createTicket(
        {
          category: "OTHER",
          subject: `[Support service] ${SERVICE_LABEL[req.serviceKey] ?? req.serviceKey}${req.quantity > 1 ? ` — ${req.quantity} products` : ""} · ${shop.name} (${req.receiptNumber})`.slice(0, 200),
          description: `${req.description}\n\nShop: ${shop.name}\nReceipt: ${req.receiptNumber} · ${req.totalPaise ? `paid ${rs(req.totalPaise)} (${req.paymentMethod?.toLowerCase()})` : `free (${req.freeReason?.toLowerCase().replace("_", " ")})`}${req.dealerId ? "\nRaised by the shop's dealer." : ""}`.slice(0, 5000),
          shopId: isOwner ? req.shopId : null,
          priority: req.totalPaise > 0 ? "HIGH" : "NORMAL",
        },
        { id: requester.id, role: requester.role } as TicketActor,
      );
      ticketId = ticket.id;
    } catch (error) {
      console.error("[support-services] ticket not created", requestId, error instanceof Error ? error.message : error);
      return null;
    }
    const files = await tx.select().from(supportServiceFiles).where(eq(supportServiceFiles.requestId, requestId));
    for (const f of files) {
      await tx.insert(supportTicketAttachments).values({
        ticketId,
        uploadedBy: requester.id,
        fileName: f.fileName,
        contentType: f.mimeType,
        sizeBytes: f.sizeBytes,
        sha256: createHash("sha256").update(f.content).digest("hex"),
        data: f.content,
      });
    }
    await tx.update(supportServiceRequests).set({ ticketId, updatedAt: new Date() }).where(eq(supportServiceRequests.id, requestId));
    return ticketId;
  });
}

/* ================================================================== refunds */

const NOT_STARTED = ["OPEN", "ACKNOWLEDGED"];

async function refundMoney(req: SupportServiceRequest, amountPaise: number, reason: string, actor: Actor) {
  if (amountPaise <= 0) return;
  if (req.paymentMethod === "WALLET") {
    await applyShopWalletEntry({ shopId: req.shopId, type: "MANUAL_CREDIT", amountPaise, reason: `Refund: support service ${req.receiptNumber} — ${reason}`, idempotencyKey: `support-service-refund:${req.id}`, createdBy: actor.id });
  } else if (req.paymentMethod === "ONLINE" && req.paymentIntentId) {
    await refundPaymentIntent({ intentId: req.paymentIntentId, amountPaise, reason: `Support service ${req.receiptNumber}: ${reason}`, idempotencyKey: `support-service-refund:${req.id}` });
  }
}

/**
 * The requester cancels. Waiting for payment: cancelled. Paid, before work
 * starts (ticket still open or acknowledged): refunded by the admin's
 * percentage, the ticket closed. After work starts: refused — an admin may
 * still refund.
 */
export async function cancelSupportRequest(requestId: string, reason: string, actor: Actor): Promise<SupportServiceRequest> {
  const req = await ownRequest(requestId, actor);
  const why = reason.trim().slice(0, 300) || "cancelled by the shop";
  if (req.status === "AWAITING_PAYMENT") {
    await db.update(supportServiceRequests).set({ status: "CANCELLED", updatedAt: new Date() }).where(and(eq(supportServiceRequests.id, requestId), eq(supportServiceRequests.status, "AWAITING_PAYMENT")));
  } else if (req.status === "PAID") {
    if (req.ticketId) {
      const [t] = await db.select({ status: supportTickets.status }).from(supportTickets).where(eq(supportTickets.id, req.ticketId));
      if (t && !NOT_STARTED.includes(t.status)) throw conflict("Work on this request has started, so it can no longer be cancelled. Contact support if something is wrong.");
    }
    const settings = await getSupportSettings();
    const amount = Math.round((req.totalPaise * settings.refundPercentBeforeWork) / 100);
    await refundMoney(req, amount, why, actor);
    await db
      .update(supportServiceRequests)
      .set({ status: amount > 0 ? "REFUNDED" : "CANCELLED", refundPaise: amount, refundReason: why, refundedAt: amount > 0 ? new Date() : null, updatedAt: new Date() })
      .where(eq(supportServiceRequests.id, requestId));
    if (req.ticketId) {
      // Through the help desk, so its history and notifications follow as for any ticket.
      await closeWithdrawnTicket(req.ticketId, { id: actor.id, role: actor.role }, `Cancelled by the requester before work started: ${why}`).catch((e) =>
        console.error("[support-services] could not close the ticket", req.ticketId, e instanceof Error ? e.message : e),
      );
    }
  } else {
    throw conflict("This request is already closed.");
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_SERVICE_CANCELLED, entityType: "support_service_request", entityId: requestId, previousValue: { status: req.status }, newValue: { reason: why } });
  return (await getRequest(requestId))!;
}

/** ADMIN only: refund a paid request (any stage), with a reason. */
export async function adminRefund(requestId: string, amountPaise: number, reason: string, actor: Actor): Promise<SupportServiceRequest> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can refund a support service.");
  const why = reason.trim().slice(0, 300);
  if (why.length < 5) throw validationFailed("Give the reason for the refund.", { fields: { reason: "Required." } });
  const req = await getRequest(requestId);
  if (!req) throw notFound("Request");
  if (req.status !== "PAID") throw conflict("Only a paid request can be refunded.");
  if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > req.totalPaise) throw validationFailed("Refund: 1 paisa up to the amount paid.");
  await refundMoney(req, amountPaise, why, actor);
  await db.update(supportServiceRequests).set({ status: "REFUNDED", refundPaise: amountPaise, refundReason: why, refundedAt: new Date(), updatedAt: new Date() }).where(eq(supportServiceRequests.id, requestId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_SERVICE_REFUNDED, entityType: "support_service_request", entityId: requestId, newValue: { amountPaise, reason: why } });
  return (await getRequest(requestId))!;
}

/* ================================================================== views */

export async function listShopRequests(shopId: string) {
  const rows = await db
    .select({ r: supportServiceRequests, ticketNumber: supportTickets.ticketNumber, ticketStatus: supportTickets.status })
    .from(supportServiceRequests)
    .leftJoin(supportTickets, eq(supportTickets.id, supportServiceRequests.ticketId))
    .where(eq(supportServiceRequests.shopId, shopId))
    .orderBy(desc(supportServiceRequests.createdAt))
    .limit(200);
  // A paid request whose ticket was not made yet (after an online payment): make it now.
  for (const row of rows) if (row.r.status === "PAID" && !row.r.ticketId) await ensureTicket(row.r.id).catch(() => null);
  return rows.map((row) => ({ ...row.r, ticketNumber: row.ticketNumber, ticketStatus: row.ticketStatus }));
}

/* ============================================================ admin: charges */

export async function listCharges() {
  return db.select().from(supportServiceCharges).orderBy(supportServiceCharges.serviceKey, desc(supportServiceCharges.version));
}

/**
 * ADMIN only: a new charge version for a service. Requests already made keep
 * theirs; open tickets are unaffected. Audited with the reason.
 */
export async function saveCharge(
  serviceKey: string,
  input: { chargeModel: SupportServiceCharge["chargeModel"]; amountPaise: number; batchSize?: number | null; gstApplicable: boolean; gstRateBp: number; freeQuotaPerMonth: number; effectiveFrom: string; effectiveTo?: string | null },
  reason: string,
  actor: Actor,
): Promise<SupportServiceCharge> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change support service charges.");
  const why = reason.trim().slice(0, 500);
  if (why.length < 5) throw validationFailed("Give the reason for the change.", { fields: { reason: "Required." } });
  const free = input.chargeModel === "FREE";
  if (!free && (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0)) throw validationFailed("Enter the amount.");
  if (input.chargeModel === "PER_BATCH" && (!input.batchSize || input.batchSize < 1)) throw validationFailed("Enter how many items make one batch.");
  if (!Number.isInteger(input.gstRateBp) || input.gstRateBp < 0 || input.gstRateBp > 2800) throw validationFailed("GST rate: 0 to 28%.");
  if (!Number.isInteger(input.freeQuotaPerMonth) || input.freeQuotaPerMonth < 0 || input.freeQuotaPerMonth > 1000) throw validationFailed("Free requests per month: 0 to 1,000.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw validationFailed("Effective from: YYYY-MM-DD.");
  return db.transaction(async (tx) => {
    const versions = await tx.select().from(supportServiceCharges).where(eq(supportServiceCharges.serviceKey, serviceKey)).orderBy(desc(supportServiceCharges.version)).for("update");
    const previous = versions.find((v) => v.status === "ACTIVE") ?? null;
    await tx.update(supportServiceCharges).set({ status: "SUPERSEDED" }).where(and(eq(supportServiceCharges.serviceKey, serviceKey), eq(supportServiceCharges.status, "ACTIVE")));
    const [row] = await tx
      .insert(supportServiceCharges)
      .values({
        serviceKey,
        version: (versions[0]?.version ?? 0) + 1,
        chargeModel: input.chargeModel,
        amountPaise: free ? 0 : input.amountPaise,
        batchSize: input.chargeModel === "PER_BATCH" ? input.batchSize : null,
        gstApplicable: input.gstApplicable,
        gstRateBp: input.gstRateBp,
        freeQuotaPerMonth: input.freeQuotaPerMonth,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo || null,
        changeReason: why,
        createdBy: actor.id,
      })
      .returning();
    const view = (c: SupportServiceCharge | null) => (c ? { version: c.version, chargeModel: c.chargeModel, amountPaise: c.amountPaise, batchSize: c.batchSize, gstApplicable: c.gstApplicable, gstRateBp: c.gstRateBp, freeQuotaPerMonth: c.freeQuotaPerMonth } : null);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_SERVICE_CHARGE_CHANGED, entityType: "support_service_charge", entityId: serviceKey, previousValue: view(previous), newValue: { ...view(row), reason: why } }, tx);
    return row;
  });
}

/** ADMIN only: refund percentage before work starts; managed-billing shops free. Audited. */
export async function saveSupportSettings(patch: { refundPercentBeforeWork?: number; freeForManagedBilling?: boolean }, reason: string, actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change support service settings.");
  const why = reason.trim().slice(0, 500);
  if (why.length < 5) throw validationFailed("Give the reason for the change.");
  if (patch.refundPercentBeforeWork != null && (!Number.isInteger(patch.refundPercentBeforeWork) || patch.refundPercentBeforeWork < 0 || patch.refundPercentBeforeWork > 100)) throw validationFailed("Refund: 0 to 100%.");
  const before = await getSupportSettings();
  await db.insert(supportServiceSettings).values({ id: "default" }).onConflictDoNothing();
  const [after] = await db.update(supportServiceSettings).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(supportServiceSettings.id, "default")).returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUPPORT_SERVICE_CHARGE_CHANGED,
    entityType: "support_service_settings",
    entityId: "default",
    previousValue: { refundPercentBeforeWork: before.refundPercentBeforeWork, freeForManagedBilling: before.freeForManagedBilling },
    newValue: { refundPercentBeforeWork: after.refundPercentBeforeWork, freeForManagedBilling: after.freeForManagedBilling, reason: why },
  });
  return after;
}

/** Staff: every request, and the report by service (requests, revenue, refunds, SLA kept). */
export async function supportServicesReport() {
  const rows = await db
    .select({ r: supportServiceRequests, shopName: shops.name, ticketNumber: supportTickets.ticketNumber, ticketStatus: supportTickets.status, resolveBy: supportTickets.resolveBy, resolvedAt: supportTickets.resolvedAt, breached: supportTickets.resolveBreachedAt })
    .from(supportServiceRequests)
    .innerJoin(shops, eq(shops.id, supportServiceRequests.shopId))
    .leftJoin(supportTickets, eq(supportTickets.id, supportServiceRequests.ticketId))
    .orderBy(desc(supportServiceRequests.createdAt))
    .limit(1000);
  const byService = new Map<string, { serviceKey: string; requests: number; paidPaise: number; refundedPaise: number; resolved: number; withinSla: number }>();
  for (const { r, resolvedAt, resolveBy, breached } of rows) {
    const cur = byService.get(r.serviceKey) ?? { serviceKey: r.serviceKey, requests: 0, paidPaise: 0, refundedPaise: 0, resolved: 0, withinSla: 0 };
    if (r.status === "PAID" || r.status === "REFUNDED") {
      cur.requests += 1;
      cur.paidPaise += r.totalPaise;
      cur.refundedPaise += r.refundPaise;
    }
    if (resolvedAt) {
      cur.resolved += 1;
      if (!breached && resolveBy && resolvedAt <= resolveBy) cur.withinSla += 1;
    }
    byService.set(r.serviceKey, cur);
  }
  return {
    requests: rows.map((x) => ({ ...x.r, shopName: x.shopName, ticketNumber: x.ticketNumber, ticketStatus: x.ticketStatus })),
    summary: [...byService.values()],
  };
}

export const SUPPORT_SERVICE_LABELS = SERVICE_LABEL;
