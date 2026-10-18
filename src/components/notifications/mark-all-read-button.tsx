"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

/** "Mark all read" on /notifications: PATCH /api/notifications { all: true }, then a fresh server render. */
export function MarkAllReadButton({ label, disabled }: { label: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={disabled || busy}
      data-testid="notifications-mark-all"
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/notifications", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ all: true }),
          });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}
