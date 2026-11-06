import { Card, PageHeader } from "@/components/ui";
import { LEGAL_ENTITY } from "@/lib/legal-docs";

export const metadata = { title: "About Us" };

export default function AboutPage() {
  return (
    <>
      <PageHeader
        title="About Us"
        description="Your neighbourhood, now online."
      />
      <Card className="p-6">
        <div className="legal-doc max-w-none text-sm leading-relaxed text-ink-700">
          <p>
            {LEGAL_ENTITY.legalName} operates this marketplace, connecting
            customers with independent local shops — grocery, pharmacy,
            jewellery, dairy, bakery and every other kind of shop in their
            neighbourhood. Rather than running our own warehouse or
            fleet, we give existing local shops — the kind you&apos;d otherwise
            only find by walking past them — an online storefront, wallet
            payments, and daily subscription delivery.
          </p>

          <h2>What we do</h2>
          <ul>
            <li>
              List independently owned, independently operated shops after
              they&apos;re reviewed and approved by our team.
            </li>
            <li>
              Provide a platform wallet for fast repeat purchases and daily
              subscriptions (milk, bread, and other everyday essentials).
            </li>
          </ul>

          <h2>What we are not</h2>
          <p>
            We are a marketplace, not the seller of record for most products
            listed — each shop is independently owned and responsible for its
            own products, pricing, and fulfilment, as set out in our{" "}
            <a href="/legal/seller-terms">Marketplace Seller Terms</a>. Full
            details on how orders, payments, and returns work are in our{" "}
            <a href="/legal/terms">Terms &amp; Conditions</a>.
          </p>

          <h2>Company details</h2>
          <ul>
            <li>
              <strong>Registered name:</strong> {LEGAL_ENTITY.legalName}
            </li>
            <li>
              <strong>Registered address:</strong> {LEGAL_ENTITY.registeredAddress}
            </li>
            <li>
              <strong>CIN / registration number:</strong>{" "}
              {LEGAL_ENTITY.cinOrRegistrationNumber}
            </li>
            <li>
              <strong>GSTIN:</strong> {LEGAL_ENTITY.gstin}
            </li>
          </ul>

          <p>
            Questions about an order, a shop, or the platform generally? Visit{" "}
            <a href="/contact">Contact Us</a>, or raise a formal complaint via{" "}
            <a href="/legal/grievance-redressal">Grievance Redressal</a>.
          </p>
        </div>
      </Card>
    </>
  );
}
