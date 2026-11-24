/**
 * WhatsApp consent for customer updates (docs/customer-whatsapp-2026-11/README.md;
 * DPDPA 2023 §6). Opt-in only: no row, or a withdrawal as the latest row, means
 * nothing is sent on WhatsApp. Changed on My Profile (source PROFILE) or by
 * sending STOP / START on WhatsApp (source WHATSAPP_KEYWORD). Every change is a
 * new user_consents row with its time and source, and is audited.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { userConsents, users, type UserConsent } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";

export const WHATSAPP_CONSENT = "WHATSAPP_NOTIFICATIONS" as const;
export const CONSENT_SOURCES = ["PROFILE", "WHATSAPP_KEYWORD"] as const;
export type WhatsAppConsentSource = (typeof CONSENT_SOURCES)[number];

export interface WhatsAppConsentStatus {
  granted: boolean;
  /** ISO time of the latest grant or withdrawal; null if never chosen. */
  lastChangedAt: string | null;
  source: string | null;
}

async function latest(userId: string, client: DbClient = db): Promise<UserConsent | undefined> {
  const [row] = await client
    .select()
    .from(userConsents)
    .where(and(eq(userConsents.userId, userId), eq(userConsents.consentType, WHATSAPP_CONSENT)))
    .orderBy(desc(userConsents.createdAt))
    .limit(1);
  return row;
}

export async function getWhatsAppConsentStatus(userId: string): Promise<WhatsAppConsentStatus> {
  const row = await latest(userId);
  return { granted: row?.granted ?? false, lastChangedAt: row ? row.createdAt.toISOString() : null, source: row?.source ?? null };
}

/** True only when the latest choice is a grant. */
export async function hasWhatsAppConsent(userId: string, client: DbClient = db): Promise<boolean> {
  return (await latest(userId, client))?.granted === true;
}

/** Records a grant or withdrawal (a new row) and audits it. A repeat of the current choice is still recorded: it is a fresh act. */
export async function setWhatsAppConsent(
  userId: string,
  granted: boolean,
  options: { source: WhatsAppConsentSource; ipAddress?: string | null },
): Promise<WhatsAppConsentStatus> {
  const consent = await recordConsent(userId, WHATSAPP_CONSENT, { granted, ipAddress: options.ipAddress ?? null, source: options.source });
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.CONSENT_RECORDED,
    entityType: "user_consent",
    entityId: consent.id,
    newValue: { consentType: WHATSAPP_CONSENT, granted, version: consent.version, source: options.source },
    ipAddress: options.ipAddress ?? null,
  });
  return { granted, lastChangedAt: consent.createdAt.toISOString(), source: options.source };
}

/** The customer's mobile number when it is verified (WhatsApp goes only there), else null. */
export async function verifiedPhoneOf(userId: string, client: DbClient = db): Promise<string | null> {
  const [user] = await client
    .select({ phone: users.phoneE164, verifiedAt: users.phoneVerifiedAt })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return user?.phone && user.verifiedAt ? user.phone : null;
}

/** "STOP" / "START" and their usual variants, in English, Hindi and Marathi. Null for anything else. */
export function parseConsentKeyword(text: string): "STOP" | "START" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["stop", "unsubscribe", "opt out", "optout", "बंद", "रोकें", "थांबवा"].includes(t)) return "STOP";
  if (["start", "subscribe", "opt in", "optin", "unstop", "शुरू", "सुरू"].includes(t)) return "START";
  return null;
}

export type SendBlock =
  | "FLAG_OFF"
  | "RULE_OFF"
  | "NO_TEMPLATE"
  | "NO_PROVIDER"
  | "STAFF_COPY"
  | "NO_VERIFIED_PHONE"
  | "NO_CONSENT"
  | "CHANNEL_SWITCHED_OFF";

export interface SendCheck {
  flagOn: boolean;
  ruleEnabled: boolean;
  template: string | null;
  providerReady: boolean;
  staffCopy: boolean;
  verifiedPhone: string | null;
  consented: boolean;
  /** The customer's WhatsApp preference for the notification's category: false = switched off. */
  channelPreference: boolean | undefined;
}

/** Why a customer update must not go out on WhatsApp, or null when it may. Checked in this order. */
export function customerSendBlock(check: SendCheck): SendBlock | null {
  if (!check.flagOn) return "FLAG_OFF";
  if (!check.ruleEnabled) return "RULE_OFF";
  if (!check.template) return "NO_TEMPLATE";
  if (!check.providerReady) return "NO_PROVIDER";
  if (check.staffCopy) return "STAFF_COPY";
  if (!check.verifiedPhone) return "NO_VERIFIED_PHONE";
  if (!check.consented) return "NO_CONSENT";
  if (check.channelPreference === false) return "CHANNEL_SWITCHED_OFF";
  return null;
}
