import Link from "next/link";

/** Section links of Admin → Delivery management (docs/hdms-2026-11). Server component. */
export const DELIVERY_SECTIONS: { key: string; label: string; href: string }[] = [
  { key: "dashboard", label: "Dashboard", href: "/admin/delivery" },
  { key: "providers", label: "Delivery providers & API", href: "/admin/delivery/providers" },
  { key: "zones", label: "Delivery zones", href: "/admin/delivery/zones" },
  { key: "pricing", label: "Delivery pricing", href: "/admin/delivery/pricing" },
  { key: "allocation", label: "Allocation rules", href: "/admin/delivery/allocation" },
  { key: "shop-riders", label: "Shop delivery personnel", href: "/admin/delivery/shop-riders" },
  { key: "partners", label: "GoKesari delivery partners", href: "/admin/delivery/partners" },
  { key: "active", label: "Active deliveries", href: "/admin/delivery/active" },
  { key: "completed", label: "Completed", href: "/admin/delivery/completed" },
  { key: "failed", label: "Failed", href: "/admin/delivery/failed" },
  { key: "cancelled", label: "Cancellations", href: "/admin/delivery/cancelled" },
  { key: "settlements", label: "Settlements & reconciliation", href: "/admin/delivery/settlements" },
  { key: "reports", label: "Delivery reports", href: "/admin/delivery/reports" },
  { key: "health", label: "Integration health", href: "/admin/delivery/health" },
  { key: "webhooks", label: "Webhook logs", href: "/admin/delivery/webhooks" },
];

export function DeliveryNav({ current }: { current: string }) {
  return (
    <nav aria-label="Delivery management" className="-mx-1 flex gap-1 overflow-x-auto pb-1 text-sm">
      {DELIVERY_SECTIONS.map((s) => (
        <Link
          key={s.key}
          href={s.href}
          aria-current={s.key === current ? "page" : undefined}
          className={`whitespace-nowrap rounded-full px-3 py-1 ${s.key === current ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700 hover:bg-cream-200"}`}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

export function paise(n: number | null | undefined): string {
  if (n == null) return "—";
  return `₹${(n / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function istTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
