"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui";

/**
 * A destructive action that asks once before it acts: the first tap shows
 * "Yes, …" and "Keep" in place (no pop-up, works the same on a phone), so a
 * slip of the thumb cannot delete or cancel anything.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  keepLabel = "Keep",
  question,
  onConfirm,
  disabled,
  size = "sm",
}: {
  children: ReactNode;
  confirmLabel: string;
  keepLabel?: string;
  question?: string;
  onConfirm: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button size={size} variant="danger" disabled={disabled} onClick={() => setAsking(true)}>
        {children}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={question ?? confirmLabel} data-testid="confirm-step">
      {question ? <span className="text-sm font-semibold text-ink-900">{question}</span> : null}
      <Button
        size={size}
        variant="danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button size={size} variant="secondary" onClick={() => setAsking(false)}>
        {keepLabel}
      </Button>
    </span>
  );
}
