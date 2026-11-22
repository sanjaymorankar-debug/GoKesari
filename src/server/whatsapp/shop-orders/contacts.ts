/**
 * The shop's WhatsApp settings (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md):
 * on/off for the shop, the owner's number (prefilled with the shop's
 * registered WhatsApp number) and up to rule whatsappShopOrders.maxStaffNumbers
 * staff numbers. Only the shop's owner manages them.
 *
 * Saving a new number queues a test template (NUMBER_CHECK). The number gets
 * orders once Meta reports that message delivered or read ("active on
 * WhatsApp"); a failure marks it "not on WhatsApp".
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { parseIndianMobile } from "@/lib/contact";
import { db } from "@/server/db";
import {
  shopWhatsappContacts,
  shopWhatsappSettings,
  shops,
  whatsappMessages,
  type ShopWhatsappContact,
  type WhatsAppContactStatus,
} from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { scheduleWhatsAppDispatch } from "./queue";
import { whatsAppFeatureState, whatsAppLiveForShop } from "./state";

export interface WhatsAppContactView {
  id: string;
  phoneE164: string;
  role: "OWNER" | "STAFF";
  label: string | null;
  optedIn: boolean;
  status: WhatsAppContactStatus;
  /** "Active on WhatsApp" / "Not on WhatsApp" / "Checking…" / "Not checked yet". */
  statusLabel: string;
  /** The test message's own state: QUEUED, SENT (Meta accepted it), DELIVERED, READ, FAILED … */
  checkMessageStatus: string | null;
  checkSentAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
}

export interface ShopWhatsAppSettingsView {
  shopId: string;
  shopName: string;
  enabled: boolean;
  /** The flag covers this shop and the server can send. */
  live: boolean;
  /** Why not, for the owner (no internals). */
  notLiveReason: string | null;
  maxStaffNumbers: number;
  /** The shop's registered WhatsApp number (prefills the owner's row). */
  shopWhatsappNumber: string | null;
  owner: WhatsAppContactView | null;
  staff: WhatsAppContactView[];
}

export const CONTACT_STATUS_LABELS: Record<WhatsAppContactStatus, string> = {
  UNCHECKED: "Not checked yet",
  CHECKING: "Checking — test message sent",
  ACTIVE: "Active on WhatsApp",
  NOT_ON_WHATSAPP: "Not on WhatsApp",
};

function view(c: ShopWhatsappContact, checkStatus: Map<string, string>): WhatsAppContactView {
  const checkMessageStatus = c.checkMessageId ? (checkStatus.get(c.checkMessageId) ?? null) : null;
  return {
    id: c.id,
    phoneE164: c.phoneE164,
    role: c.role,
    label: c.label,
    optedIn: c.optedIn,
    status: c.status,
    statusLabel:
      c.status === "CHECKING" && checkMessageStatus === "SENT" ? "Checking — WhatsApp accepted the test message, waiting for delivery" : CONTACT_STATUS_LABELS[c.status],
    checkMessageStatus,
    checkSentAt: c.checkSentAt?.toISOString() ?? null,
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    lastError: c.lastError,
  };
}

/** The shop, if this user owns it. Operators and admins do not manage a shop's WhatsApp numbers. */
async function ownedShop(shopId: string, userId: string) {
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, ownerId: shops.ownerId, ownerName: shops.ownerName, whatsappNumber: shops.whatsappNumber, pincode: shops.pincode })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== userId) throw forbidden("Only the shop's owner can manage its WhatsApp order alerts.");
  return shop;
}

export async function getShopWhatsAppSettings(shopId: string, userId: string): Promise<ShopWhatsAppSettingsView> {
  const shop = await ownedShop(shopId, userId);
  const [[settings], contacts, rule, live, state] = await Promise.all([
    db.select().from(shopWhatsappSettings).where(eq(shopWhatsappSettings.shopId, shopId)),
    db
      .select()
      .from(shopWhatsappContacts)
      .where(and(eq(shopWhatsappContacts.shopId, shopId), isNull(shopWhatsappContacts.removedAt)))
      .orderBy(shopWhatsappContacts.createdAt),
    getRule("whatsappShopOrders"),
    whatsAppLiveForShop({ pincode: shop.pincode }),
    whatsAppFeatureState(),
  ]);
  const checkIds = contacts.map((c) => c.checkMessageId).filter((id): id is string => Boolean(id));
  const checkStatus = new Map(
    checkIds.length
      ? (await db.select({ id: whatsappMessages.id, status: whatsappMessages.status }).from(whatsappMessages).where(inArray(whatsappMessages.id, checkIds))).map((m) => [m.id, m.status as string])
      : [],
  );
  const shopNumber = shop.whatsappNumber ? parseIndianMobile(shop.whatsappNumber) : null;
  return {
    shopId,
    shopName: shop.name,
    enabled: settings?.enabled ?? false,
    live,
    notLiveReason: live ? null : state.flagOn ? "WhatsApp order alerts are being set up by GoKesari; your numbers are saved and will be used once it is ready." : "WhatsApp order alerts are not available in your area yet.",
    maxStaffNumbers: rule.maxStaffNumbers,
    shopWhatsappNumber: shopNumber?.ok ? shopNumber.e164 : null,
    owner: contacts.filter((c) => c.role === "OWNER").map((c) => view(c, checkStatus))[0] ?? null,
    staff: contacts.filter((c) => c.role === "STAFF").map((c) => view(c, checkStatus)),
  };
}

export interface SaveWhatsAppSettingsInput {
  enabled: boolean;
  owner: { phone: string; optedIn: boolean; label?: string | null } | null;
  staff: { phone: string; label?: string | null; optedIn?: boolean }[];
}

function e164(phone: string, who: string): string {
  const parsed = parseIndianMobile(phone);
  if (!parsed.ok) throw validationFailed(`${who}: ${parsed.error}`);
  return parsed.e164;
}

/**
 * Saves the shop's switch and numbers. A number that is new (or was not on
 * WhatsApp before) gets a test message; unchanged numbers keep their status.
 * Removed numbers stop getting orders at once.
 */
export async function saveShopWhatsAppSettings(
  shopId: string,
  userId: string,
  input: SaveWhatsAppSettingsInput,
): Promise<{ settings: ShopWhatsAppSettingsView; checksQueued: number }> {
  const shop = await ownedShop(shopId, userId);
  const rule = await getRule("whatsappShopOrders");
  if (input.staff.length > rule.maxStaffNumbers) {
    throw validationFailed(`You can add at most ${rule.maxStaffNumbers} staff number(s).`);
  }
  const wanted: { phoneE164: string; role: "OWNER" | "STAFF"; label: string | null; optedIn: boolean }[] = [];
  if (input.owner) {
    wanted.push({ phoneE164: e164(input.owner.phone, "Owner's number"), role: "OWNER", label: input.owner.label?.trim() || shop.ownerName || "Owner", optedIn: input.owner.optedIn });
  }
  input.staff.forEach((s, i) =>
    wanted.push({ phoneE164: e164(s.phone, `Staff number ${i + 1}`), role: "STAFF", label: s.label?.trim() || `Staff ${i + 1}`, optedIn: s.optedIn ?? true }),
  );
  const seen = new Set<string>();
  for (const w of wanted) {
    if (seen.has(w.phoneE164)) throw validationFailed(`${w.phoneE164} is listed twice.`);
    seen.add(w.phoneE164);
  }
  if (input.enabled && !wanted.some((w) => w.optedIn)) {
    throw validationFailed("Add at least one number that agrees to get order alerts, or switch WhatsApp alerts off.");
  }
  const live = await whatsAppLiveForShop({ pincode: shop.pincode });

  const checksQueued = await db.transaction(async (tx) => {
    await tx
      .insert(shopWhatsappSettings)
      .values({ shopId, enabled: input.enabled, updatedBy: userId })
      .onConflictDoUpdate({ target: shopWhatsappSettings.shopId, set: { enabled: input.enabled, updatedBy: userId, updatedAt: new Date() } });
    const current = await tx
      .select()
      .from(shopWhatsappContacts)
      .where(and(eq(shopWhatsappContacts.shopId, shopId), isNull(shopWhatsappContacts.removedAt)))
      .for("update");
    const byPhone = new Map(current.map((c) => [c.phoneE164, c]));
    for (const c of current) {
      if (!seen.has(c.phoneE164)) {
        await tx.update(shopWhatsappContacts).set({ removedAt: new Date(), updatedAt: new Date() }).where(eq(shopWhatsappContacts.id, c.id));
      }
    }
    let queued = 0;
    for (const w of wanted) {
      const existing = byPhone.get(w.phoneE164);
      let contact: ShopWhatsappContact;
      if (existing) {
        [contact] = await tx
          .update(shopWhatsappContacts)
          .set({ role: w.role, label: w.label, optedIn: w.optedIn, updatedAt: new Date() })
          .where(eq(shopWhatsappContacts.id, existing.id))
          .returning();
      } else {
        [contact] = await tx
          .insert(shopWhatsappContacts)
          .values({ shopId, phoneE164: w.phoneE164, role: w.role, label: w.label, optedIn: w.optedIn, createdBy: userId })
          .returning();
      }
      // A number is checked once (again after it was found not on WhatsApp, or never checked), and only when it can be sent.
      if (live && w.optedIn && (contact.status === "UNCHECKED" || contact.status === "NOT_ON_WHATSAPP")) {
        await queueNumberCheck(tx, contact, shop.name, rule.testMessageTemplate);
        queued += 1;
      }
    }
    return queued;
  });
  if (checksQueued > 0) scheduleWhatsAppDispatch(true);
  return { settings: await getShopWhatsAppSettings(shopId, userId), checksQueued };
}

/** Sends the test message to one number again (the owner's "Check again"). */
export async function recheckWhatsAppNumber(shopId: string, userId: string, contactId: string): Promise<ShopWhatsAppSettingsView> {
  const shop = await ownedShop(shopId, userId);
  if (!(await whatsAppLiveForShop({ pincode: shop.pincode }))) throw validationFailed("WhatsApp order alerts are not available for your shop yet.");
  const rule = await getRule("whatsappShopOrders");
  await db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(shopWhatsappContacts)
      .where(and(eq(shopWhatsappContacts.id, contactId), eq(shopWhatsappContacts.shopId, shopId), isNull(shopWhatsappContacts.removedAt)))
      .for("update");
    if (!contact) throw notFound("WhatsApp number");
    await queueNumberCheck(tx, contact, shop.name, rule.testMessageTemplate);
  });
  scheduleWhatsAppDispatch(true);
  return getShopWhatsAppSettings(shopId, userId);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function queueNumberCheck(tx: Tx, contact: ShopWhatsappContact, shopName: string, template: string): Promise<void> {
  const [message] = await tx
    .insert(whatsappMessages)
    .values({
      shopId: contact.shopId,
      contactId: contact.id,
      kind: "NUMBER_CHECK",
      template,
      params: { shopName },
      intendedTo: contact.phoneE164,
      status: "QUEUED",
    })
    .returning({ id: whatsappMessages.id });
  await tx
    .update(shopWhatsappContacts)
    .set({ status: "CHECKING", checkMessageId: message.id, checkSentAt: new Date(), verifiedAt: null, lastError: null, updatedAt: new Date() })
    .where(eq(shopWhatsappContacts.id, contact.id));
}
