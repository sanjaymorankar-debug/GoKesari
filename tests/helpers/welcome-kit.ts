/**
 * docs/shop-welcome-kit-2026-11 (26-Nov-2026): every registration path checks that the shop it made live got
 * exactly one welcome kit in the document-email outbox (TC-WKIT-035 … 038).
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { documentEmails } from "@/server/db/schema";

export async function welcomeKitCount(shopId: string): Promise<number> {
  const rows = await db
    .select({ id: documentEmails.id })
    .from(documentEmails)
    .where(and(eq(documentEmails.docType, "SHOP_WELCOME_KIT"), eq(documentEmails.docId, shopId)));
  return rows.length;
}
