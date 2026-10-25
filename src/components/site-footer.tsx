import { LanguageSwitch } from "@/components/board/board-header";
import { BrandTagline, BrandWordmark } from "@/components/brand-wordmark";
import { FooterColumns, type FooterColumn } from "@/components/footer-columns";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";
import { LEGAL_ENTITY } from "@/lib/legal-docs";

/**
 * Site footer (docs/homepage-uiux-2026-10, F5): four labelled columns —
 * Company, Make Money, Support, Legal — that fold into accordions on phones,
 * then a bottom bar with the language switch and the company line
 * (legal name and GSTIN). Every page keeps the same links it had.
 */
export function SiteFooter({ lang = "en" }: { lang?: Lang }) {
  const columns: FooterColumn[] = [
    {
      key: "company",
      title: tr(HOME.footerCompany, lang),
      links: [
        { href: "/about", label: tr(HOME.aboutUs, lang) },
        { href: "/contact", label: tr(HOME.contactUs, lang) },
        { href: "/driving-simulator", label: "Driving Simulator" },
      ],
    },
    {
      key: "make-money",
      title: tr(HOME.footerMakeMoney, lang),
      links: [
        { href: "/sell", label: tr(HOME.sellOnGoKesari, lang) },
        { href: "/delivery-partner/apply", label: tr(HOME.becomeDeliveryPartner, lang) },
        { href: "/legal/seller-terms", label: tr(HOME.sellerTerms, lang) },
      ],
    },
    {
      key: "support",
      title: tr(HOME.footerSupport, lang),
      links: [
        { href: "/support", label: tr(HOME.help, lang) },
        { href: "/grievance", label: tr(HOME.fileComplaint, lang) },
        { href: "/legal/grievance-redressal", label: tr(HOME.grievanceRedressal, lang) },
      ],
    },
    {
      key: "legal",
      title: tr(HOME.footerLegal, lang),
      links: [
        { href: "/legal/privacy-policy", label: tr(HOME.privacyPolicy, lang) },
        { href: "/legal/terms", label: tr(HOME.terms, lang) },
        { href: "/legal/refund-policy", label: tr(HOME.refundPolicy, lang) },
        { href: "/legal/shipping-policy", label: tr(HOME.shippingPolicy, lang) },
        { href: "/legal/cookie-policy", label: tr(HOME.cookiePolicy, lang) },
        { href: "/legal/subscription-terms", label: tr(HOME.subscriptionTerms, lang) },
        { href: "/legal/wallet-terms", label: tr(HOME.walletTerms, lang) },
        { href: "/legal/voucher-terms", label: tr(HOME.voucherTerms, lang) },
      ],
    },
  ];

  return (
    <footer lang={LANG_TAG[lang]} className="border-t border-cream-200 bg-white" data-testid="site-footer">
      <div className="mx-auto max-w-6xl px-4 pb-4 pt-5 sm:px-6 lg:pt-8">
        <FooterColumns columns={columns} />
        <div className="mt-4 flex flex-col items-center gap-3 border-t border-cream-200 pt-4 lg:mt-6 lg:flex-row lg:justify-between">
          <div className="flex items-center gap-2" data-testid="footer-language">
            <span className="text-sm font-semibold text-ink-700">{tr(UI.language, lang)}</span>
            <LanguageSwitch lang={lang} variant="buttons" />
          </div>
          <p className="text-center text-xs leading-snug text-ink-600 lg:text-right" data-testid="footer-company-line">
            <BrandWordmark className="text-xs" /> · <BrandTagline className="text-xs" /> · © {LEGAL_ENTITY.legalName} · GSTIN {LEGAL_ENTITY.gstin}
          </p>
        </div>
      </div>
    </footer>
  );
}
