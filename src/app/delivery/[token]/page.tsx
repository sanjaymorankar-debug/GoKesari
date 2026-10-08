import { notFound } from "next/navigation";

import { StaffDeliveryView } from "@/components/staff-delivery-view";
import { AppError } from "@/lib/errors";
import { getStaffLinkView } from "@/server/services/fulfilment-options";

export const metadata = { title: "Delivery", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The private delivery link of a shop's own delivery person
 * (docs/four-features-2026-10, feature 1). No sign-in: the link is the
 * permission, for one order, while it is with that person.
 */
export default async function StaffDeliveryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const view = await getStaffLinkView(token);
    return <StaffDeliveryView token={token} initial={view} />;
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}
