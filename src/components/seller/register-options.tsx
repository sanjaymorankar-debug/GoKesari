import Link from "next/link";

import { Icon } from "@/components/board/icons";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  signIn: L("Sign in — we email you a one-time code", "साइन इन करें — हम आपको ईमेल पर एक बार का कोड भेजेंगे", "साइन इन करा — आम्ही तुम्हाला ईमेलवर एकदाचा कोड पाठवू"),
  referralAndId: L("Your referral code and GST or PAN", "आपका रेफ़रल कोड और GST या PAN", "तुमचा रेफरल कोड आणि GST किंवा PAN"),
  idOnly: L("Your GST or PAN (and referral code, if you have one)", "आपका GST या PAN (और रेफ़रल कोड, अगर हो)", "तुमचा GST किंवा PAN (आणि रेफरल कोड, असल्यास)"),
  address: L("Confirm your address and mark your shop on the map", "अपना पता पक्का करें और नक्शे पर दुकान लगाएँ", "तुमचा पत्ता निश्चित करा आणि नकाशावर दुकान दाखवा"),
  pay: L("Pay the registration fee online — your shop goes live", "पंजीकरण शुल्क ऑनलाइन भरें — आपकी दुकान लाइव हो जाएगी", "नोंदणी शुल्क ऑनलाइन भरा — तुमचे दुकान लाइव्ह होईल"),
  title: L("Register your shop", "अपनी दुकान रजिस्टर करें", "तुमचे दुकान नोंदवा"),
  live: L("Live as soon as you pay", "भुगतान करते ही लाइव", "पैसे भरताच लाइव्ह"),
  registerMine: L("Register my shop", "मेरी दुकान रजिस्टर करें", "माझे दुकान नोंदवा"),
  signInToRegister: L("Sign in to register", "रजिस्टर करने के लिए साइन इन करें", "नोंदणीसाठी साइन इन करा"),
} as const;

/**
 * The one way a shop joins GoKesari (owner brief, 08-Nov-2026: one registration flow):
 * /shop/register, the step-by-step wizard — GST / PAN and the referral code first, then the
 * owner name if the record has none, the address and map pin, the shop name, the fee, live.
 * Used on the "Sell on GoKesari" page and on Seller Central before a shop exists.
 */
export function RegisterOptions({
  referralRequired,
  signedIn,
  lang = "en",
}: {
  referralRequired: boolean;
  signedIn: boolean;
  /** Module 6: the board language (English by default). */
  lang?: Lang;
}) {
  const steps = [
    ...(signedIn ? [] : [tr(T.signIn, lang)]),
    referralRequired ? tr(T.referralAndId, lang) : tr(T.idOnly, lang),
    tr(T.address, lang),
    tr(T.pay, lang),
  ];
  return (
    <div className="flex flex-col rounded-2xl border border-kesari-300 bg-white p-5 shadow-sm ring-1 ring-kesari-300 md:max-w-xl" data-testid="register-options">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-kesari-700 text-white">
          <Icon name="zap" size={22} />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-ink-900">{tr(T.title, lang)}</h3>
          <p className="text-sm font-semibold text-kesari-800">{tr(T.live, lang)}</p>
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
        {signedIn ? tr(T.registerMine, lang) : tr(T.signInToRegister, lang)}
        <Icon name="chevron-right" size={18} />
      </Link>
    </div>
  );
}
