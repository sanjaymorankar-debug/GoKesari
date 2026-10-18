/**
 * Route glue for the batch-2026-10 WS-D product-data endpoints: who may see a
 * job, and the translation of this area's errors into the app's AppErrors.
 */
import { AppError, conflict, forbidden, validationFailed } from "@/lib/errors";
import type { AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import type { PmdIngestJob } from "@/server/db/schema";

import { mapPmdError } from "./api";
import { DataSourceDisabledError } from "./data-sources/types";
import { manufacturerAccountsForUser } from "./manufacturers";

/** Staff with PMD_VIEW see every job; a manufacturer member sees its own account's jobs. */
export async function assertJobAccess(job: Pick<PmdIngestJob, "manufacturerAccountId">, user: AuthenticatedUser): Promise<"STAFF" | "MANUFACTURER"> {
  if (can(user.role, PERMISSIONS.PMD_VIEW)) return "STAFF";
  if (job.manufacturerAccountId) {
    const accounts = await manufacturerAccountsForUser(user.id);
    if (accounts.some((a) => a.id === job.manufacturerAccountId)) return "MANUFACTURER";
  }
  throw forbidden("You cannot see this import.");
}

export async function guardedWsd<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataSourceDisabledError) throw conflict(e.message, { reason: "SOURCE_DISABLED", source: e.sourceKey });
    const mapped = mapPmdError(e);
    if (mapped instanceof AppError) throw mapped;
    throw mapped;
  }
}

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export async function readUploadedFile(request: Request): Promise<{ bytes: Buffer; fileName: string }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw validationFailed("Send the file as multipart/form-data in the field 'file'.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw validationFailed("Choose a .csv or .xlsx file.");
  if (file.size === 0) throw validationFailed("The file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw validationFailed("The file is larger than 60 MB; split it.");
  return { bytes: Buffer.from(await file.arrayBuffer()), fileName: file.name || "upload.csv" };
}
