/**
 * What the review screen needs besides the draft: the files' types (for the
 * viewer) and the shop's listings (for the product picker).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { accFiles } from "@/server/db/schema";
import { listListings } from "./stock";

export async function reviewFiles(shopId: string, fileIds: string[]) {
  if (fileIds.length === 0) return [];
  const rows = await db
    .select({ id: accFiles.id, contentType: accFiles.contentType, name: accFiles.originalName })
    .from(accFiles)
    .where(and(eq(accFiles.shopId, shopId), inArray(accFiles.id, fileIds)));
  return fileIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
}

export async function reviewListings(shopId: string) {
  return (await listListings(shopId)).map((l) => ({ shopProductId: l.shopProductId, name: l.name, sellableUnit: l.sellableUnit, hsn: l.hsn, gstRateBp: l.gstRateBp }));
}
