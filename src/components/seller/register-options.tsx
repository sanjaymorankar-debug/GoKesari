import Link from "next/link";

import { Icon } from "@/components/board/icons";

/**
 * The one way a shop joins GoKesari (owner brief, 30 Oct 2026: "a single
 * registration process"): /shop/register, which signs the owner in, takes the
 * referral code, the documents (or "later"), the fee, then the map pin. The
 * old "Quick registration" card led to /shop/join, which now only forwards to
 * /shop/register, so it was the same journey shown twice.
 * Used on the "Sell on GoKesari" page and on Seller Central before a shop exists.
 */
export function RegisterOptions({ referralRequired, signedIn }: { referralRequired: boolean; signedIn: boolean }) {
  const steps = [
    ...(signedIn ? [] : ["Sign in — we email you a one-time code"]),
    referralRequired ? "Your referral code (or request one)" : "Your referral code, if you have one (or request one)",
    "Validate your GST or PAN, Shop Act and FSSAI — or add them later",
    "Confirm your shop and owner name",
    "Pay the registration fee online",
    "Your shop's address and map location",
  ];
  return (
    <div className="flex flex-col rounded-2xl border border-kesari-300 bg-white p-5 shadow-sm ring-1 ring-kesari-300 md:max-w-xl" data-testid="register-options">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-kesari-700 text-white">
          <Icon name="zap" size={22} />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-ink-900">Register your shop</h3>
          <p className="text-sm font-semibold text-kesari-800">Live as soon as you pay</p>
        </div>
      </div>
      <ol className="mt-3 flex flex-col gap-1.5 text-sm text-ink-700" data-testid="register-steps">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-ink-700">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <Link
        href="/shop/register"
        className="mt-5 inline-flex h-12 items-center justify-center gap-1.5 rounded-xl bg-kesari-700 px-4 text-base font-bold text-white hover:bg-kesari-800"
        data-testid="register-start"
      >
        {signedIn ? "Register my shop" : "Sign in to register"}
        <Icon name="chevron-right" size={18} />
      </Link>
    </div>
  );
}
