import Link from "next/link";

import { LEGAL_DOCS, LEGAL_ENTITY } from "@/lib/legal-docs";

/** Which footer column a policy page sits in; anything not listed goes under Policies. */
const COMPANY_SLUGS = ["seller-terms"];
const PAYMENT_SLUGS = ["subscription-terms", "wallet-terms", "voucher-terms", "grievance-redressal"];

const linkClass = "inline-block py-1 underline decoration-cream-200 underline-offset-2 hover:text-ink-900 hover:decoration-ink-500";

function Column({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <nav aria-label={title}>
      <h2 className="mb-1 text-sm font-semibold text-ink-900">{title}</h2>
      <ul>
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className={linkClass}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Site footer: who runs GoKesari, then every company, policy and help link in three columns. */
export function SiteFooter() {
  const doc = (slug: string) => {
    const found = LEGAL_DOCS.find((d) => d.slug === slug);
    return found ? [{ href: `/legal/${found.slug}`, label: found.shortLabel }] : [];
  };
  const policies = LEGAL_DOCS.filter(
    (d) => !COMPANY_SLUGS.includes(d.slug) && !PAYMENT_SLUGS.includes(d.slug),
  ).map((d) => ({ href: `/legal/${d.slug}`, label: d.shortLabel }));

  return (
    <footer className="border-t border-cream-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-6 px-4 py-8 text-sm text-ink-600 sm:grid-cols-2 sm:px-6 lg:grid-cols-[minmax(0,2.6fr)_1fr_1fr_1fr]">
        <div>
          <p className="text-base font-bold text-ink-900">
            Go<span className="text-kesari-600">Kesari</span>
          </p>
          <p className="mt-1">Everything for Everyone: every local shop near you, in one directory.</p>
          <p className="mt-1 text-xs text-ink-500">
            {LEGAL_ENTITY.legalName} · GSTIN {LEGAL_ENTITY.gstin}
          </p>
        </div>
        <Column
          title="Company"
          links={[
            { href: "/about", label: "About Us" },
            { href: "/contact", label: "Contact Us" },
            { href: "/delivery-partner/apply", label: "Become a Delivery Partner" },
            ...COMPANY_SLUGS.flatMap(doc),
          ]}
        />
        <Column title="Policies" links={policies} />
        <Column
          title="Payments & help"
          links={[...PAYMENT_SLUGS.flatMap(doc), { href: "/grievance", label: "File a complaint" }]}
        />
      </div>
    </footer>
  );
}
