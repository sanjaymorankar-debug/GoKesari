/** RBAC v2 documents: GET ?shopId= lists a shop's documents and versions; POST (multipart) uploads a document or a new version. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { STAFF_DOC_TYPES, type StaffDocType } from "@/server/db/schema";
import { listShopDocuments, uploadStaffDocument } from "@/server/rbac-support/documents";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const { shopId } = parseQuery(request, z.object({ shopId: z.string().uuid() }));
  const docs = await listShopDocuments(shopId, actor);
  return ok(docs.map((d) => ({ ...d, versions: d.versions })));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose a file.");
  const docType = String(form?.get("docType") ?? "");
  if (!(STAFF_DOC_TYPES as readonly string[]).includes(docType)) throw validationFailed("Choose the document type.");
  const str = (k: string) => {
    const v = String(form?.get(k) ?? "").trim();
    return v || null;
  };
  const result = await uploadStaffDocument(
    {
      shopId: str("shopId") ?? "",
      shopProductId: str("shopProductId"),
      documentId: str("documentId"),
      docType: docType as StaffDocType,
      title: str("title") ?? file.name,
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      ticketId: str("ticketId"),
    },
    actor,
  );
  return ok(result, 201);
});
