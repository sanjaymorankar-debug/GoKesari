import { BrandTagline, BrandWordmark } from "@/components/brand-wordmark";
import { FooterLinkRow, type FooterLink } from "@/components/footer-link-row";
import { LEGAL_DOCS, LEGAL_ENTITY } from "@/lib/legal-docs";

/** Which footer row a policy page sits in; anything not listed goes with the policies. */
const COMPANY_SLUGS = ["seller-terms"];
const PAYMENT_SLUGS = ["subscription-terms", "wallet-terms", "voucher-terms", "grievance-redressal"];

/** Site footer, Amazon style: every company, policy and help link in two compact rows, then one small line naming the company. */
export function SiteFooter() {
  const doc = (slug: string): FooterLink[] => {
    const found = LEGAL_DOCS.find((d) => d.slug === slug);
    return found ? [{ href: `/legal/${found.slug}`, label: found.shortLabel }] : [];
  };
  const policies = LEGAL_DOCS.filter(
    (d) => !COMPANY_SLUGS.includes(d.slug) && !PAYMENT_SLUGS.includes(d.slug),
  ).map((d) => ({ href: `/legal/${d.slug}`, label: d.shortLabel }));

  const company: FooterLink[] = [
    { href: "/about", label: "About Us" },
    { href: "/contact", label: "Contact Us" },
    { href: "/sell", label: "Sell on GoKesari" },
    { href: "/delivery-partner/apply", label: "Become a Delivery Partner" },
    ...COMPANY_SLUGS.flatMap(doc),
  ];
  const policiesAndHelp: FooterLink[] = [
    ...policies,
    ...PAYMENT_SLUGS.flatMap(doc),
    { href: "/grievance", label: "File a complaint" },
  ];

  return (
    <footer className="border-t border-cream-200 bg-white" data-testid="site-footer">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-1 px-4 py-3 text-center text-xs text-ink-600 sm:px-6">
        <FooterLinkRow label="Company" links={company} />
        <FooterLinkRow label="Policies and help" links={policiesAndHelp} />
        <p className="mt-1 text-[11px] leading-snug text-ink-500" data-testid="footer-company-line">
          <BrandWordmark className="text-xs" /> · <BrandTagline className="text-[11px]" /> · © {LEGAL_ENTITY.legalName} · GSTIN{" "}
          {LEGAL_ENTITY.gstin}
        </p>
      </div>
    </footer>
  );
}
