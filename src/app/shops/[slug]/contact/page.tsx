import { notFound } from "next/navigation";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { isFoodBusinessShopType } from "@/lib/shop-types";
import { getPublicVerifiedDocuments } from "@/server/services/seller-verification";
import { getPublicShopBySlug, shopCustomerContact } from "@/server/services/shops";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shop = await getPublicShopBySlug(slug);
  return { title: shop ? `Seller information — ${shop.name}` : "Shop" };
}

/**
 * Seller/contact information (Consumer Protection (E-Commerce) Rules 2020,
 * Rule 5 — legal name, address, customer care contact, and applicable
 * registrations must be disclosed to the customer before purchase). Kept as
 * its own page, linked from the shop's main product listing, so that page
 * stays focused on browsing and ordering.
 */
export default async function ShopContactPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shop = await getPublicShopBySlug(slug);
  if (!shop) notFound();
  const verified = await getPublicVerifiedDocuments(shop.id);
  // C1: only the numbers the shopkeeper entered for customers (rule shopContact).
  const contact = await shopCustomerContact(shop);

  return (
    <>
      <PageHeader
        title="Seller information"
        description={
          <Link href={`/shops/${slug}`} className="text-kesari-600 hover:underline">
            ← Back to {shop.name}
          </Link>
        }
      />
      <Card className="p-6">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-ink-700">Sold by</dt>
            <dd className="text-ink-500">{shop.legalBusinessName || shop.name}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">Owner / Proprietor</dt>
            <dd className="text-ink-500">{shop.ownerName}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">Address</dt>
            <dd className="text-ink-500">
              {shop.addressLine1}
              {shop.addressLine2 ? `, ${shop.addressLine2}` : ""}
              <br />
              {[shop.area, shop.city].filter(Boolean).join(", ")} — {shop.pincode}
            </dd>
          </div>
          <div data-testid="shop-customer-care">
            <dt className="font-medium text-ink-700">Customer care</dt>
            <dd className="text-ink-500">
              {contact.phone ? <a href={`tel:+91${contact.phone}`} className="hover:underline">{contact.phone}</a> : null}
              {contact.whatsapp ? (
                <>
                  {contact.phone ? <br /> : null}
                  <a
                    href={`https://wa.me/91${contact.whatsapp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-kesari-600 hover:underline"
                  >
                    WhatsApp {contact.whatsapp}
                  </a>
                </>
              ) : null}
              {contact.usePlatformCare ? (
                <>
                  GoKesari customer care: {LEGAL_ENTITY.supportEmail}
                </>
              ) : null}
              {shop.email ? (
                <>
                  <br />
                  {shop.email}
                </>
              ) : null}
            </dd>
          </div>
          {shop.gstin ? (
            <div>
              <dt className="font-medium text-ink-700">GSTIN</dt>
              <dd className="text-ink-500">{shop.gstin}</dd>
            </div>
          ) : null}
          {isFoodBusinessShopType(shop.shopType) ? (
            <div>
              <dt className="font-medium text-ink-700">FSSAI licence</dt>
              <dd className="text-ink-500">
                {shop.fssaiLicenseNumber || "Not yet on file with the platform"}
              </dd>
            </div>
          ) : null}
          <div className="sm:col-span-2" data-testid="verified-documents">
            <dt className="font-medium text-ink-700">Verified by Gokesari</dt>
            <dd className="text-ink-500">
              {verified.length
                ? `${verified.map((v) => v.label).join(", ")} — checked against government records.`
                : "No documents verified yet."}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium text-ink-700">Return &amp; refund</dt>
            <dd className="text-ink-500">
              {shop.returnPolicyText || (
                <>
                  See the platform&apos;s{" "}
                  <a href="/legal/refund-policy" className="underline">
                    Refund &amp; Cancellation Policy
                  </a>
                  .
                </>
              )}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
