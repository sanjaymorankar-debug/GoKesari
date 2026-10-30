import Link from "next/link";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";

interface Option {
  key: string;
  icon: IconName;
  title: string;
  badge: string;
  text: string;
  steps: string[];
  href: string;
  cta: string;
  primary: boolean;
}

/**
 * The two ways a shop joins GoKesari, side by side, so an owner picks the
 * one that fits before filling in anything:
 *  - with a distributor's referral code: pay the fee online, live on payment
 *    (/shop/join — shown only while self-registration is switched on);
 *  - with documents: an operator reviews the registration (/shop/register).
 * Used on the "Sell on GoKesari" page and on Seller Central before a shop exists.
 */
export function RegisterOptions({ selfService, referralRequired, signedIn }: { selfService: boolean; referralRequired: boolean; signedIn: boolean }) {
  const options: Option[] = [
    ...(selfService
      ? [
          {
            key: "join",
            icon: "zap" as const,
            title: "Quick registration",
            badge: "Live as soon as you pay",
            text: referralRequired
              ? "Have a referral code from a GoKesari distributor? Register with your shop name and mobile number, and pay the fee online."
              : "Register with your shop name and mobile number (and a referral code if a distributor gave you one), then pay the fee online.",
            steps: ["Sign in — we email you a one-time code", "Referral code, then your documents (or add them later)", "Pay the registration fee online — live on payment"],
            href: "/shop/join",
            cta: "Register and pay online",
            primary: true,
          },
        ]
      : []),
    {
      key: "register",
      icon: "file-check",
      title: "Register with documents",
      badge: "Reviewed by our team",
      text: "Tell us about your shop and its registration (Shop Act, PAN or Udyam). A GoKesari operator reviews it and you are told when it is approved.",
      steps: [...(signedIn ? [] : ["Sign in with your mobile or email"]), "Shop details, address and documents", "Approval by a GoKesari operator"],
      href: signedIn ? "/shop/register" : "/signin",
      cta: signedIn ? "Register my shop" : "Sign in to register",
      primary: !selfService,
    },
  ];

  return (
    <ul className={clsx("grid gap-4", options.length > 1 && "md:grid-cols-2")} data-testid="register-options">
      {options.map((o) => (
        <li
          key={o.key}
          className={clsx("flex flex-col rounded-2xl border bg-white p-5 shadow-sm", o.primary ? "border-kesari-300 ring-1 ring-kesari-300" : "border-slate-200")}
          data-testid={`register-option-${o.key}`}
        >
          <div className="flex items-start gap-3">
            <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", o.primary ? "bg-kesari-700 text-white" : "bg-slate-100 text-ink-700")}>
              <Icon name={o.icon} size={22} />
            </span>
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-ink-900">{o.title}</h3>
              <p className="text-sm font-semibold text-kesari-800">{o.badge}</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-ink-700">{o.text}</p>
          <ol className="mt-3 flex flex-col gap-1.5 text-sm text-ink-700">
            {o.steps.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-ink-700">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <Link
            href={o.href}
            className={clsx(
              "mt-5 inline-flex h-12 items-center justify-center gap-1.5 rounded-xl px-4 text-base font-bold",
              o.primary ? "bg-kesari-700 text-white hover:bg-kesari-800" : "border-2 border-ink-900 text-ink-900 hover:bg-slate-50",
            )}
          >
            {o.cta}
            <Icon name="chevron-right" size={18} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
