import Link from "next/link";

import { Icon, type IconName } from "@/components/board/icons";
import { BrandWordmark } from "@/components/brand-wordmark";
import { RegisterOptions } from "@/components/seller/register-options";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { SHOP_TYPES } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { isReferralRequired } from "@/server/services/referral-settings";
import { getRule } from "@/server/services/settings";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = {
  title: "Sell on GoKesari",
  description:
    "Bring your local shop online. Reach customers in your neighbourhood, take daily subscriptions and wallet payments, and run it all from GoKesari Seller Central.",
};
export const dynamic = "force-dynamic";

const BENEFITS: { icon: IconName; title: string; text: string }[] = [
  { icon: "map-pin", title: "Customers near you", text: "Shoppers in your area find your shop, see what's open now and order for delivery or pickup." },
  { icon: "calendar-clock", title: "Daily subscriptions", text: "Milk, bread, eggs — regular customers subscribe once and you deliver every day." },
  { icon: "wallet", title: "Prepaid & wallet payments", text: "Customers pay online or from their GoKesari wallet; settlements go to your verified bank account." },
  { icon: "bike", title: "Delivery your way", text: "Deliver with your own staff, or hand orders to GoKesari delivery partners where available." },
];

const STEPS: { title: string; text: string }[] = [
  { title: "Register your shop", text: "Shop name, mobile number and address. Takes a few minutes." },
  { title: "Get verified", text: "Add your GST or PAN, shop licences and a payout bank account." },
  { title: "List your products", text: "Pick from our product master, upload prices from Excel or snap a photo catalogue." },
  { title: "Start selling", text: "Accept orders, pack, deliver — and watch your numbers grow in Seller Central." },
];

const TOOLS: { icon: IconName; title: string; points: string[] }[] = [
  { icon: "package", title: "Orders", points: ["New, packing, ready and out — one board", "Returns and disputes handled in one place", "Assign deliveries to your riders"] },
  { icon: "boxes", title: "Catalogue", points: ["Stock levels and low-stock alerts", "Bulk price updates from Excel", "Photo catalogue and product categories"] },
  { icon: "indian-rupee", title: "Payments", points: ["Settlements and invoices", "GST returns (GSTR-1) and e-invoices", "Connect your accounting software"] },
  { icon: "megaphone", title: "Growth", points: ["Offers and discount coupons", "Marketing campaigns to your customers", "Sales and performance analytics"] },
];

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "What does it cost to sell on GoKesari?",
    a: (
      <>
        A one-time registration fee — you always see the exact amount before you pay. Fees and commission on orders are set out in the{" "}
        <Link href="/legal/seller-terms" className="font-semibold text-kesari-800 underline">Seller Terms</Link>.
      </>
    ),
  },
  {
    q: "Which shops can join?",
    a: `Every kind of local shop — ${SHOP_TYPES.length} shop types from kirana, dairy and bakery to pharmacy, electronics and restaurants.`,
  },
  {
    q: "How long does approval take?",
    a: "With a distributor's referral code and online payment, your shop goes live as soon as the payment is confirmed. Registrations with documents are reviewed by a GoKesari operator, and you are notified as soon as yours is approved.",
  },
  {
    q: "How do I get paid?",
    a: "Add a payout bank account in Seller Central. Once it is verified, your settlements are paid into it; every settlement and invoice is listed under Payments.",
  },
  {
    q: "Who delivers the orders?",
    a: "You choose: add your own delivery staff in Seller Central, or use GoKesari delivery partners where they operate.",
  },
  {
    q: "Can I manage my shop from my phone?",
    a: "Yes. Seller Central works on any phone, tablet or computer, in English, हिन्दी and मराठी.",
  },
];

/**
 * "Sell on GoKesari" (modelled on sell.amazon.in): the public front door for
 * shop owners — why sell here, how it works, what Seller Central gives you,
 * the ways to register and answers to the usual questions. It has its own
 * seller header (the shopping site's header and footer step aside, as in
 * Seller Central); a signed-in owner is sent straight on to Seller Central.
 */
export default async function SellPage() {
  const user = await getCurrentUser();
  const [shops, selfService, referralRequired] = await Promise.all([
    user ? listShopsForOwner(user.id).catch(() => []) : Promise.resolve([]),
    getRule("selfRegistration").then((r) => r.enabled).catch(() => false),
    isReferralRequired("shop").catch(() => false),
  ]);
  const isSeller = shops.length > 0;
  const start = isSeller ? { href: "/shop", label: "Go to Seller Central" } : { href: "#register", label: "Start selling" };
  const signInHref = user ? "/shop" : "/signin";

  return (
    <div data-seller-central className="min-h-[100svh] bg-white text-ink-900" data-testid="sell-page">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-900 text-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/sell" className="flex min-h-11 shrink-0 items-center gap-2" aria-label="GoKesari for sellers">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/gk-mark.png" alt="" width={62} height={36} className="h-9 w-auto rounded-md bg-white p-0.5" />
            <span className="flex flex-col leading-tight">
              <BrandWordmark tone="dark" className="text-base" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">for sellers</span>
            </span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 text-sm font-semibold text-slate-200 md:flex" aria-label="On this page">
            <a href="#how-it-works" className="rounded-lg px-3 py-2 hover:bg-white/10 hover:text-white">How it works</a>
            <a href="#tools" className="rounded-lg px-3 py-2 hover:bg-white/10 hover:text-white">Seller Central</a>
            <a href="#register" className="rounded-lg px-3 py-2 hover:bg-white/10 hover:text-white">Register</a>
            <a href="#faq" className="rounded-lg px-3 py-2 hover:bg-white/10 hover:text-white">FAQ</a>
          </nav>
          <span className="flex-1" />
          {isSeller ? null : (
            <Link href={signInHref} className="hidden h-11 items-center rounded-lg px-3 text-sm font-semibold hover:bg-white/10 sm:flex">
              {user ? "Seller Central" : "Sign in"}
            </Link>
          )}
          <Link href={start.href} className="flex h-11 items-center whitespace-nowrap rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white hover:bg-kesari-700" data-testid="sell-start">
            {start.label}
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-ink-900 via-[#1e293b] to-kesari-800 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-20">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm font-semibold text-kesari-100">
              <Icon name="store" size={16} />
              For local shops across India
            </p>
            <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              Your shop, open online to your whole neighbourhood
            </h1>
            <p className="mt-4 max-w-xl text-lg text-slate-200">
              Sell on GoKesari and reach customers near you. Take orders, daily subscriptions and prepaid payments, and run everything from one place — Seller Central.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href={start.href} className="inline-flex h-12 items-center gap-1.5 rounded-xl bg-kesari-600 px-6 text-base font-bold text-white shadow-lg hover:bg-kesari-700">
                {start.label}
                <Icon name="chevron-right" size={18} />
              </Link>
              <a href="#how-it-works" className="inline-flex h-12 items-center rounded-xl border-2 border-white/40 px-6 text-base font-bold text-white hover:bg-white/10">
                See how it works
              </a>
            </div>
            {isSeller ? null : (
              <p className="mt-4 text-sm text-slate-300">
                Already selling on GoKesari?{" "}
                <Link href={signInHref} className="font-semibold text-white underline">
                  Sign in to Seller Central
                </Link>
              </p>
            )}
          </div>
          {/* A glimpse of Seller Central: the numbers an owner sees first. */}
          <div className="hidden rounded-2xl bg-white p-5 text-ink-900 shadow-2xl lg:block" aria-hidden>
            <p className="text-xs font-bold uppercase tracking-wider text-ink-500">Seller Central · example</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {[
                { label: "New orders", value: "12", accent: true },
                { label: "Packing", value: "5" },
                { label: "Out for delivery", value: "8" },
                { label: "Subscriptions", value: "64" },
              ].map((s) => (
                <div key={s.label} className={s.accent ? "rounded-lg border border-kesari-600 bg-kesari-50 p-3" : "rounded-lg border border-slate-200 bg-slate-50 p-3"}>
                  <p className="text-sm font-semibold text-ink-600">{s.label}</p>
                  <p className={s.accent ? "text-3xl font-bold text-kesari-800" : "text-3xl font-bold"}>{s.value}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3 rounded-lg bg-ink-900 p-3 text-white">
              <Icon name="indian-rupee" size={20} className="text-kesari-300" />
              <span className="flex-1 text-sm text-slate-300">Settled to your bank</span>
              <span className="font-bold">Every cycle</span>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="border-b border-slate-200 bg-slate-50">
        <ul className="mx-auto grid max-w-6xl gap-4 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {BENEFITS.map((b) => (
            <li key={b.title} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-kesari-100 text-kesari-700">
                <Icon name={b.icon} size={22} />
              </span>
              <h2 className="mt-3 text-base font-bold">{b.title}</h2>
              <p className="mt-1 text-sm text-ink-600">{b.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-14 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
        <p className="mt-2 text-ink-600">Four steps from registration to your first order.</p>
        <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-ink-900 text-lg font-bold text-white">{i + 1}</span>
              <h3 className="mt-3 text-lg font-bold">{s.title}</h3>
              <p className="mt-1 text-sm text-ink-600">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Seller Central tools */}
      <section id="tools" className="scroll-mt-20 bg-ink-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight">Everything in Seller Central</h2>
          <p className="mt-2 max-w-2xl text-slate-300">
            One portal for your whole business — on your phone or computer, in English, हिन्दी or मराठी.
          </p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TOOLS.map((t) => (
              <li key={t.title} className="rounded-xl bg-white/5 p-5 ring-1 ring-white/10">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-kesari-600 text-white">
                  <Icon name={t.icon} size={20} />
                </span>
                <h3 className="mt-3 text-lg font-bold">{t.title}</h3>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm text-slate-300">
                  {t.points.map((p) => (
                    <li key={p} className="flex gap-2">
                      <Icon name="check" size={16} className="mt-0.5 shrink-0 text-kesari-300" />
                      {p}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Shop types */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Every kind of local shop</h2>
        <ul className="mt-6 flex flex-wrap gap-2">
          {SHOP_TYPES.slice(0, 16).map((t) => (
            <li key={t.key} className="rounded-full border border-slate-200 bg-slate-50 px-3.5 py-1.5 text-sm font-medium text-ink-700">
              {t.label}
            </li>
          ))}
          <li className="rounded-full bg-kesari-50 px-3.5 py-1.5 text-sm font-semibold text-kesari-800">and {SHOP_TYPES.length - 16} more</li>
        </ul>
      </section>

      {/* Register */}
      <section id="register" className="scroll-mt-20 border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          {isSeller ? (
            <div className="flex flex-col items-start gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:flex-row sm:items-center">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-leaf-100 text-leaf-700">
                <Icon name="circle-check" size={24} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-bold">You already sell on GoKesari</h2>
                <p className="text-ink-600">{shops[0].name} is in your Seller Central.</p>
              </div>
              <Link href="/shop" className="inline-flex h-12 items-center rounded-xl bg-kesari-700 px-5 font-bold text-white hover:bg-kesari-800">
                Go to Seller Central
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-3xl font-bold tracking-tight">Register your shop</h2>
              <p className="mt-2 max-w-2xl text-ink-600">
                Choose the way that suits you. Keep your mobile number handy{referralRequired ? " and the referral code from your GoKesari distributor" : ""}.
              </p>
              <div className="mt-8">
                <RegisterOptions selfService={selfService} referralRequired={referralRequired} signedIn={user !== null} />
              </div>
              <div className="mt-8 rounded-xl bg-white p-5 ring-1 ring-slate-200">
                <h3 className="font-bold">Keep these ready</h3>
                <ul className="mt-3 grid gap-2 text-sm text-ink-700 sm:grid-cols-2 lg:grid-cols-4">
                  {["Mobile number for OTP", "Shop name and full address", "GST or PAN, Shop Act or Udyam", "Bank account for payouts"].map((x) => (
                    <li key={x} className="flex items-center gap-2">
                      <Icon name="circle-check" size={18} className="shrink-0 text-leaf-600" />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-14 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Questions sellers ask</h2>
        <div className="mt-6 divide-y divide-slate-200 rounded-xl ring-1 ring-slate-200">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 py-3 text-base font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <Icon name="chevron-down" size={18} className="shrink-0 text-kesari-700 transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-4 text-sm leading-relaxed text-ink-700">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Closing call to action */}
      <section className="bg-kesari-700 text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h2 className="text-2xl font-bold">Ready to bring your shop online?</h2>
            <p className="text-kesari-100">Join the local shops already selling on GoKesari.</p>
          </div>
          <Link href={start.href} className="inline-flex h-12 items-center rounded-xl bg-white px-6 font-bold text-kesari-800 hover:bg-kesari-50">
            {start.label}
          </Link>
        </div>
      </section>

      <footer className="bg-ink-900 text-sm text-slate-300">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {LEGAL_ENTITY.legalName}
          </p>
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Seller links">
            <Link href="/legal/seller-terms" className="hover:text-white">Seller Terms</Link>
            <Link href="/contact" className="hover:text-white">Contact us</Link>
            <Link href="/" className="hover:text-white">Shop on GoKesari</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
