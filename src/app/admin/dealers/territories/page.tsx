import { redirect } from "next/navigation";

export const metadata = { title: "Franchise" };

/** Owner, 21-Nov-2026: a territory and a franchise are the same thing; territories are sold as franchise zones. */
export default function TerritoryDealersPage() {
  redirect("/admin/franchise");
}
