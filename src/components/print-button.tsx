"use client";

import { Button } from "@/components/ui";

/** Opens the browser's print dialog (print or "Save as PDF"). */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
