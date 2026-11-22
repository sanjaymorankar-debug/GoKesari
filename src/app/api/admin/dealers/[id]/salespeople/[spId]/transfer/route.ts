/**
 * Owner, 22-Nov-2026: moving a team lead / agent to another dealer's team needs signed consent letters and a second
 * admin's approval — use Admin → Dealers → Referral moves (POST /api/admin/referral-moves, kind MEMBER).
 */
import { conflict } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await requireRole("ADMIN");
  throw conflict("Moving a person to another dealer now needs consent letters and a second admin's approval: use Admin → Dealers → Referral moves.");
});
