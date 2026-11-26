/**
 * Shop owner: the registration subscription banner (top of every Seller Central screen) and the
 * "Shop Registration" card (0210; owner brief 25-Nov-2026). Server-rendered; works the same in the
 * Android / iPhone app, which shows these pages. English with a Marathi line.
 */
import Link from "next/link";

export interface RegistrationStatusView {
  shopId: string;
  status: "UNPAID" | "ACTIVE" | "EXPIRING_SOON" | "GRACE" | "EXPIRED" | "EXEMPT";
  registeredOn: string | null;
  expiryOn: string | null;
  offlineOn: string | null;
  daysLeft: number | null;
  amountDue: string | null;
  payUrl: string;
  payLabel: string;
}

const STATUS_TEXT: Record<RegistrationStatusView["status"], { en: string; mr: string }> = {
  UNPAID: { en: "Payment pending", mr: "शुल्क बाकी" },
  ACTIVE: { en: "Active", mr: "सक्रिय" },
  EXPIRING_SOON: { en: "Expiring soon", mr: "लवकरच संपत आहे" },
  GRACE: { en: "Grace period", mr: "सवलत कालावधी" },
  EXPIRED: { en: "Expired", mr: "संपली" },
  EXEMPT: { en: "No fee needed", mr: "शुल्क आवश्यक नाही" },
};

function PayButton({ view }: { view: RegistrationStatusView }) {
  const cls = "inline-flex min-h-11 items-center justify-center rounded-md bg-kesari-700 px-4 text-sm font-semibold text-white hover:bg-kesari-800";
  return view.payUrl.startsWith("http") ? (
    <a href={view.payUrl} className={cls} data-testid="registration-pay">
      {view.payLabel}
    </a>
  ) : (
    <Link href={view.payUrl} className={cls} data-testid="registration-pay">
      {view.payLabel}
    </Link>
  );
}

/** Red: unpaid, grace, expired. Amber: expiring soon. Nothing while active or exempt. Stays until paid. */
export function RegistrationBanner({ view }: { view: RegistrationStatusView | null }) {
  if (!view || view.status === "ACTIVE" || view.status === "EXEMPT") return null;
  const red = view.status !== "EXPIRING_SOON";
  const text =
    view.status === "UNPAID"
      ? { en: "Registration payment pending — your shop will not receive orders.", mr: "नोंदणी शुल्क बाकी — शुल्क भरेपर्यंत तुमच्या दुकानाला ऑर्डर मिळणार नाहीत." }
      : view.status === "EXPIRING_SOON"
        ? {
            en: `Your shop registration expires on ${view.expiryOn}${view.daysLeft != null ? ` (${view.daysLeft} day${view.daysLeft === 1 ? "" : "s"} left)` : ""}. Renew to keep receiving orders.`,
            mr: `तुमची दुकान नोंदणी ${view.expiryOn} रोजी संपत आहे. ऑर्डर मिळत राहण्यासाठी नूतनीकरण करा.`,
          }
        : view.status === "GRACE"
          ? {
              en: `Your shop registration expired on ${view.expiryOn}. Renew before ${view.offlineOn} or your shop will be hidden from customers.`,
              mr: `तुमची दुकान नोंदणी ${view.expiryOn} रोजी संपली. ${view.offlineOn} पूर्वी नूतनीकरण करा, नाहीतर दुकान ग्राहकांना दिसणार नाही.`,
            }
          : {
              en: `Your shop registration expired on ${view.expiryOn}. Your shop is hidden from customers and gets no new orders until you renew.`,
              mr: `तुमची दुकान नोंदणी ${view.expiryOn} रोजी संपली. नूतनीकरण करेपर्यंत दुकान ग्राहकांना दिसणार नाही.`,
            };
  return (
    <div
      role="alert"
      data-testid="registration-banner"
      data-status={view.status}
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${red ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{text.en}</p>
        <p lang="mr">{text.mr}</p>
        {view.amountDue ? <p className="mt-1">Amount due: {view.amountDue}</p> : null}
      </div>
      <PayButton view={view} />
    </div>
  );
}

/** The dashboard's Shop Registration card: status, registration date, expiry, days left, amount due, Pay / Renew. */
export function RegistrationCard({ view }: { view: RegistrationStatusView | null }) {
  if (!view) return null;
  const tone =
    view.status === "ACTIVE" || view.status === "EXEMPT" ? "border-green-200 bg-green-50" : view.status === "EXPIRING_SOON" ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50";
  const row = (label: string, value: string | null) => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-ink-600">{label}</dt>
      <dd className="text-right font-medium text-ink-900">{value ?? "—"}</dd>
    </div>
  );
  return (
    <section aria-labelledby="registration-card-title" data-testid="registration-card" className={`mb-4 rounded-lg border p-4 ${tone}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="registration-card-title" className="text-base font-semibold text-ink-900">
          Shop Registration <span className="text-sm font-normal text-ink-600" lang="mr">· दुकान नोंदणी</span>
        </h2>
        <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-ink-800">
          {STATUS_TEXT[view.status].en} · <span lang="mr">{STATUS_TEXT[view.status].mr}</span>
        </span>
      </div>
      <dl className="text-sm">
        {row("Registration date", view.registeredOn)}
        {row("Expiry date", view.status === "UNPAID" ? "Registration payment pending" : view.expiryOn)}
        {row("Days left", view.daysLeft == null ? null : String(Math.max(0, view.daysLeft)))}
        {row("Amount due", view.amountDue ?? "Nothing due")}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {view.status !== "ACTIVE" && view.status !== "EXEMPT" ? <PayButton view={view} /> : null}
        <Link href={`/shop/manage/registration?shop=${view.shopId}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 underline">
          Payment history and receipts
        </Link>
      </div>
    </section>
  );
}
