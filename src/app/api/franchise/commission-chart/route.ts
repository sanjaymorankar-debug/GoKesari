/** Public: the commission chart (§9) from live Admin config — the one-time cases A1–A4 / B1–B4 and the recurring rules. */
import { ok, route } from "@/server/api/handler";
import { commissionChart } from "@/server/franchise/chart";

export const dynamic = "force-dynamic";

export const GET = route(async () => ok(await commissionChart()));
