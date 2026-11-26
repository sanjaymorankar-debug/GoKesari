/**
 * Rider App v2 (rule riderAppV2): header + page + bottom bar for approved
 * riders on /delivery-partner and its sub-pages (src/app/delivery-partner/layout.tsx).
 */
import type { ReactNode } from "react";

import type { Lang } from "@/lib/board/i18n";

import type { RiderAvailability } from "./availability";
import { RiderBottomNav } from "./bottom-nav";
import { RiderHeader } from "./rider-header";

export interface RiderShellProps {
  availability: RiderAvailability;
  canGoOnline: boolean;
  hasActiveDelivery: boolean;
  activeOrderNumber: string | null;
  sosNumber: string | null;
  tiersOn: boolean;
  lang: Lang;
}

export function RiderShell({ children, ...props }: RiderShellProps & { children: ReactNode }) {
  return (
    <div data-testid="rider-shell">
      <RiderHeader {...props} />
      {children}
      <RiderBottomNav lang={props.lang} />
    </div>
  );
}
