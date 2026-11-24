/**
 * GoKesari Health for staff (docs/health/; owner brief §6, §7). health:manage (admins and operators);
 * settings: admins; break-glass: health:break_glass + rule health.breakGlassEnabled (checked in the service).
 *
 * GET ?view=
 *   providers&kind=DOCTOR|CARE&status&q · documents&member · stores&kind=PHARMACY|EQUIPMENT&status&q · legal&shopId
 *   drugs&q · drugsCsv (pharmacist review sheet) · careCategories · specialties · equipment · settings · report&granularity&from&to
 *   accessLog&from&to&action&role&patientId · audit&from&to · dataRequests&status&kind
 * POST { action, … }:
 *   decideProvider {kind, profileId, decision, note, memberIds} · police {memberId, status}
 *   decideStore {kind, shopId, decision, note} · drug {drug} · importDrugs {csv} · importIcd {csv}
 *   registryCheck {memberId, note}
 *   equipment {item} · deleteEquipment {id} · findPatient {q} · breakGlass {patientId, reason}
 *   dataRequest {id, decision, note}
 * Patient lookups go in POST bodies, never in the URL.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { memberDocumentLinks } from "@/server/consult/files";
import {
  accessLogList,
  breakGlassFind,
  breakGlassOpen,
  careCategories,
  decideDataRequest,
  decideProvider,
  decideStore,
  deleteEquipmentMaster,
  drugMasterStats,
  healthAuditList,
  healthReport,
  healthSettingsView,
  healthSpecialties,
  listDataRequests,
  listEquipmentMaster,
  providerQueue,
  recordRegistryCheck,
  saveEquipmentMaster,
  setPoliceVerification,
  storeLegalStatus,
  storeQueue,
} from "@/server/health/admin";
import { exportDrugsCsv, importDrugsCsv, importIcdCsv, listDrugs, saveDrug } from "@/server/health/drugs";

export const dynamic = "force-dynamic";

/** CSV imports: 5 MB of text is about 50 000 medicines. */
const MAX_CSV_CHARS = 5_000_000;

const csvOf = (v: unknown) => {
  const csv = z.string().min(1, "Choose a CSV file.").parse(v);
  if (csv.length > MAX_CSV_CHARS) throw validationFailed("The file is too large (5 MB at most). Split it and import each part.");
  return csv;
};

const ipOf = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.HEALTH_MANAGE);
  const q = Object.fromEntries(request.nextUrl.searchParams.entries());
  switch (q.view ?? "providers") {
    case "providers":
      return ok({ providers: await providerQueue(user, q) });
    case "documents":
      return ok({ documents: await memberDocumentLinks(z.string().uuid().parse(q.member), user) });
    case "stores":
      return ok({ stores: await storeQueue(user, q) });
    case "legal":
      return ok(await storeLegalStatus(String(q.shopId ?? ""), user));
    case "drugs":
      return ok({ drugs: await listDrugs(user, q.q ?? "", 300), stats: await drugMasterStats(user) });
    case "drugsCsv":
      return ok({ csv: await exportDrugsCsv(user) });
    case "careCategories":
      return ok({ categories: await careCategories(user) });
    case "specialties":
      return ok({ groups: await healthSpecialties(user) });
    case "equipment":
      return ok({ items: await listEquipmentMaster(user) });
    case "settings":
      return ok(await healthSettingsView(user));
    case "report":
      return ok(await healthReport(user, q));
    case "accessLog":
      return ok(await accessLogList(user, q));
    case "audit":
      return ok({ rows: await healthAuditList(user, q) });
    case "dataRequests":
      return ok({ requests: await listDataRequests(user, q) });
    default:
      throw validationFailed("Unknown view.");
  }
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.HEALTH_MANAGE);
  enforceRateLimit(`health-admin:${user.id}`, RATE_LIMITS.MUTATION);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  switch (body.action) {
    case "decideProvider":
      return ok(await decideProvider(body, user));
    case "police":
      return ok(await setPoliceVerification(String(body.memberId ?? ""), body.status, user));
    case "decideStore":
      return ok(await decideStore(body, user));
    case "drug":
      return ok({ drug: await saveDrug(body.drug ?? {}, user) });
    case "importDrugs":
      return ok(await importDrugsCsv(csvOf(body.csv), user));
    case "importIcd":
      return ok(await importIcdCsv(csvOf(body.csv), user));
    case "registryCheck":
      return ok(await recordRegistryCheck(body, user));
    case "equipment":
      return ok({ item: await saveEquipmentMaster(body.item ?? {}, user) });
    case "deleteEquipment":
      await deleteEquipmentMaster(String(body.id ?? ""), user);
      return ok({ deleted: true });
    case "findPatient":
      return ok({ patients: await breakGlassFind({ q: body.q }, user) });
    case "breakGlass":
      return ok(await breakGlassOpen(String(body.patientId ?? ""), String(body.reason ?? ""), user, ipOf(request)));
    case "dataRequest":
      return ok(await decideDataRequest(body, user));
    default:
      throw validationFailed("Unknown action.");
  }
});
