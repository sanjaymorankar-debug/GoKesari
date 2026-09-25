/**
 * Presentational primitives.
 *
 * Deliberately dumb: no data fetching, no business rules. They render what a
 * server component hands them (§3 — business logic stays out of the UI).
 */
import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatPaiseCompact } from "@/lib/money";

/* --------------------------------------------------------------- layout */

export function Card({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-cream-200 bg-white shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-ink-500">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Section({
  title,
  href,
  linkLabel = "View all",
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
        {href ? (
          <Link
            href={href}
            className="text-sm font-medium text-kesari-600 hover:underline"
          >
            {linkLabel} →
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- badges */

export function ClassificationBadge({
  value,
}: {
  value: "KESARI" | "GREEN" | null;
}) {
  if (!value) return null;
  const isKesari = value === "KESARI";
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        isKesari
          ? "bg-kesari-100 text-kesari-700"
          : "bg-leaf-100 text-leaf-700",
      )}
    >
      {isKesari ? "Kesari" : "Green"}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  const tones = {
    neutral: "bg-slate-100 text-ink-600",
    success: "bg-leaf-100 text-leaf-700",
    warning: "bg-amber-100 text-amber-700",
    danger: "bg-red-100 text-red-700",
    info: "bg-sky-100 text-sky-700",
  } as const;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Makes the §12 online/offline distinction unmistakable on every product. */
export function AvailabilityBadge({
  onlineSaleEnabled,
  offlineSaleEnabled,
  isAvailable,
  outOfStock,
}: {
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  isAvailable: boolean;
  outOfStock: boolean;
}) {
  if (!onlineSaleEnabled && offlineSaleEnabled) {
    return <Badge tone="warning">In-shop only</Badge>;
  }
  if (onlineSaleEnabled && !isAvailable) {
    return <Badge tone="danger">Unavailable</Badge>;
  }
  if (onlineSaleEnabled && outOfStock) {
    return <Badge tone="danger">Out of stock</Badge>;
  }
  if (onlineSaleEnabled && offlineSaleEnabled) {
    return <Badge tone="success">Online &amp; in-shop</Badge>;
  }
  if (onlineSaleEnabled) return <Badge tone="info">Online only</Badge>;
  return <Badge>Unavailable</Badge>;
}

const SUCCESS_STATUSES = new Set(["DELIVERED", "CONFIRMED", "APPROVED", "PAID", "MATCHED", "RECONCILED", "SETTLED"]);
const DANGER_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "PAYMENT_FAILED",
  "WALLET_INSUFFICIENT",
  "FAILED",
  "DISPUTED",
  "REVERSED",
  "EXCEPTION",
  "UNMATCHED",
]);
const WARNING_STATUSES = new Set(["PENDING", "PENDING_APPROVAL", "RETURNED", "PARTIAL", "PROCESSING", "UNPAID"]);

export function StatusBadge({ status }: { status: string }) {
  const tone = SUCCESS_STATUSES.has(status)
    ? "success"
    : DANGER_STATUSES.has(status)
      ? "danger"
      : WARNING_STATUSES.has(status)
        ? "warning"
        : "info";
  return <Badge tone={tone}>{status.replace(/_/g, " ").toLowerCase()}</Badge>;
}

/* -------------------------------------------------------------- controls */

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  const variants = {
    primary:
      "bg-kesari-600 text-white hover:bg-kesari-700 disabled:bg-kesari-300",
    secondary:
      "border border-cream-200 bg-white text-ink-700 hover:bg-cream-100 disabled:text-ink-400",
    ghost: "text-ink-600 hover:bg-cream-100",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  } as const;
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-2.5 text-base",
  } as const;

  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
        variant === "primary"
          ? "bg-kesari-600 text-white hover:bg-kesari-700"
          : "border border-cream-200 bg-white text-ink-700 hover:bg-cream-100",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function Money({
  paise,
  className,
}: {
  paise: number;
  className?: string;
}) {
  return (
    <span className={clsx("tabular-nums", className)}>
      {formatPaiseCompact(paise)}
    </span>
  );
}

/* ---------------------------------------------------------- feedback */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Card className="p-10 text-center">
      <p className="text-base font-medium text-ink-700">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </Card>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-900",
    success: "border-leaf-300 bg-leaf-50 text-leaf-700",
  } as const;
  return (
    <div className={clsx("rounded-lg border p-3 text-sm", tones[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? "mt-0.5" : undefined}>{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">
        {label}
      </span>
      {children}
      {hint && !error ? (
        <span className="mt-1 block text-xs text-ink-500">{hint}</span>
      ) : null}
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-kesari-500 focus:outline-none";
