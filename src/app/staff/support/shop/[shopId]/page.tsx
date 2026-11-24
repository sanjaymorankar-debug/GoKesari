import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";

import { PendingShopChanges } from "@/components/shop/pending-shop-changes";
import { DocumentsPanel, ShopWorkbench } from "@/components/staff/support-desk";
import { Alert, PageHeader, Section } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { products, shopListingDetails, shopProducts, shops, STAFF_DOC_TYPES, supportTickets } from "@/server/db/schema";
import { FIELD_LABELS, listShopChangeRequests, SHOP_FIELDS } from "@/server/rbac-support/change-requests";
import { toChangeViews } from "@/server/rbac-support/views";
import { listShopDocuments } from "@/server/rbac-support/documents";
import { isFeatureEnabledForRole } from "@/server/services/feature-flags";

export const metadata = { title: "Shop workbench" };
export const dynamic = "force-dynamic";

/** Module 6: Hindi / Marathi for the page's own words (English unchanged). */
const T = {
  myTickets: L("← My tickets", "← मेरे टिकट", "← माझी तिकिटे"),
  description: L(
    "{owner} · {city} {pincode} · GSTIN {gstin} · FSSAI {fssai} · status {status}",
    "{owner} · {city} {pincode} · GSTIN {gstin} · FSSAI {fssai} · स्थिति {status}",
    "{owner} · {city} {pincode} · GSTIN {gstin} · FSSAI {fssai} · स्थिती {status}",
  ),
  notice: L(
    "Nothing you change here is applied until the shop owner approves it. GSTIN / PAN change only through government verification; master product data through an admin.",
    "यहाँ किया कोई भी बदलाव दुकान मालिक की मंज़ूरी के बाद ही लागू होगा। GSTIN / PAN सिर्फ़ सरकारी सत्यापन से बदलते हैं; मास्टर उत्पाद डेटा एडमिन के ज़रिए।",
    "इथे केलेला कोणताही बदल दुकान मालकाच्या मंजुरीनंतरच लागू होईल. GSTIN / PAN फक्त सरकारी पडताळणीने बदलतात; मास्टर उत्पादन माहिती ॲडमिनमार्फत.",
  ),
  waiting: L("Waiting for the owner ({n})", "मालिक का इंतज़ार ({n})", "मालकाची वाट ({n})"),
} as const;

/**
 * RBAC v2 Phase 4/5: the Support User's workbench for one shop, opened from a ticket assigned to them. Shop data is
 * shown (bank details are never shown here; purchase cost is not part of it) and every edit becomes a change
 * request for the owner. A Support Manager may open any shop.
 */
export default async function ShopWorkbenchPage({ params, searchParams }: { params: Promise<{ shopId: string }>; searchParams: Promise<{ ticket?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_CHANGE_PROPOSE) && !can(user.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) redirect("/staff");
  if (!(await isFeatureEnabledForRole("rbac_v2_shop_change_requests", user.role))) redirect("/staff/support");
  const { shopId } = await params;
  const lang = await getBoardLang();
  const ticketId = (await searchParams).ticket ?? null;
  if (!can(user.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE) && user.role !== "ADMIN") {
    // A Support User sees only the shop of a ticket assigned to them (brief §3.5).
    if (!ticketId) notFound();
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
    if (!t || t.assignedToUserId !== user.id || t.shopId !== shopId) notFound();
  }
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) notFound();
  const rows = await db
    .select({ sp: shopProducts, name: products.name, masterMrp: products.mrpPaise, shopMrp: shopListingDetails.mrpPaise })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
    .orderBy(asc(products.name))
    .limit(300);
  const pending = await toChangeViews(await listShopChangeRequests(shopId, { id: user.id, role: "ADMIN" }));
  const record = shop as Record<string, unknown>;
  const ist = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const docs = (await listShopDocuments(shopId, user)).map((d) => ({
    id: d.id,
    title: d.title,
    docType: d.docType,
    verificationStatus: d.verificationStatus,
    currentVersion: d.currentVersion,
    versions: d.versions.map((v) => ({ version: v.version, filename: v.filename, uploadedAtIst: ist(v.uploadedAt) })),
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/staff/support?tab=mine" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        {tr(T.myTickets, lang)}
      </Link>
      <PageHeader
        title={shop.name}
        description={tr(T.description, lang)
          .replace("{owner}", shop.ownerName ?? "")
          .replace("{city}", String(shop.city))
          .replace("{pincode}", String(shop.pincode))
          .replace("{gstin}", shop.gstin ?? "—")
          .replace("{fssai}", shop.fssaiLicenseNumber ?? "—")
          .replace("{status}", shop.status)}
      />
      <Alert tone="info">{tr(T.notice, lang)}</Alert>
      <div className="mt-3">
        <ShopWorkbench
          shopId={shopId}
          ticketId={ticketId}
          shopFields={SHOP_FIELDS.map((f) => ({ field: f, label: FIELD_LABELS[f], value: record[f] == null ? "" : String(record[f]) }))}
          products={rows.map((r) => ({
            shopProductId: r.sp.id,
            name: r.name,
            onlinePricePaise: r.sp.onlinePricePaise,
            offlinePricePaise: r.sp.offlinePricePaise,
            mrpPaise: r.shopMrp ?? r.masterMrp ?? null,
            isAvailable: r.sp.isAvailable,
          }))}
        />
      </div>
      <div className="mt-3">
        <DocumentsPanel shopId={shopId} ticketId={ticketId} docs={docs} types={[...STAFF_DOC_TYPES]} canVerify={can(user.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE) || user.role === "ADMIN"} />
      </div>
      <Section title={tr(T.waiting, lang).replace("{n}", String(pending.length))}>
        <PendingShopChanges requests={pending} readOnly />
      </Section>
    </div>
  );
}
