/**
 * Where uploaded bills and portal files live (docs/inventory-accounting-2026-10, Part 7).
 *
 *   ACCOUNTS_STORAGE=s3    an S3-compatible bucket (AWS S3, Cloudflare R2,
 *                          Backblaze B2, MinIO…): ACCOUNTS_S3_ENDPOINT,
 *                          ACCOUNTS_S3_BUCKET, ACCOUNTS_S3_REGION,
 *                          ACCOUNTS_S3_ACCESS_KEY_ID, ACCOUNTS_S3_SECRET_ACCESS_KEY.
 *                          Objects are private; keys are shops/<shop id>/<random>.
 *   MEDIA_DIR set          a folder outside the web root, shops/<shop id>/…
 *   otherwise              the database row (bytea), as other uploads do today.
 *
 * Bytes are encrypted before they leave the process (AES-256-GCM with
 * INTEGRATION_ENCRYPTION_KEY) whenever that key is set, so neither the
 * bucket nor the database holds a readable bill. Files are only ever served
 * through /api/shops/{shopId}/accounts/files/{fileId}, which checks the
 * caller's access to that shop and that the file belongs to it.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { accFiles, type AccFile } from "@/server/db/schema";
import { mediaRoot } from "@/server/media/blob-store";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
};

/** Content type from the bytes themselves (never trust the browser's label alone). */
export function sniffContentType(bytes: Buffer, declared: string | null | undefined, name?: string | null): string | null {
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(4, 12).toString("latin1").startsWith("ftyphei") || head.subarray(4, 12).toString("latin1").startsWith("ftypmif")) return "image/heic";
  if (head[0] === 0x50 && head[1] === 0x4b) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; // zip: xlsx
  const lower = (name ?? "").toLowerCase();
  const text = bytes.subarray(0, 2048).toString("utf8").trimStart();
  if (text.startsWith("{") || text.startsWith("[")) return "application/json";
  if (lower.endsWith(".csv") || declared === "text/csv") return "text/csv";
  if (declared === "text/plain" || lower.endsWith(".txt")) return "text/plain";
  return null;
}

/* ------------------------------------------------------------ encryption */

function fileKey(): Buffer | null {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

function encrypt(bytes: Buffer): { body: Buffer; encrypted: boolean } {
  const key = fileKey();
  if (!key) return { body: bytes, encrypted: false };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { body: Buffer.concat([iv, cipher.getAuthTag(), body]), encrypted: true };
}

function decrypt(stored: Buffer, encrypted: boolean): Buffer {
  if (!encrypted) return stored;
  const key = fileKey();
  if (!key) throw new Error("This file is encrypted but INTEGRATION_ENCRYPTION_KEY is not set.");
  const decipher = createDecipheriv("aes-256-gcm", key, stored.subarray(0, 12));
  decipher.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
}

/* -------------------------------------------------------------------- S3 */

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function s3Config(): S3Config | null {
  if ((process.env.ACCOUNTS_STORAGE ?? "").trim().toLowerCase() !== "s3") return null;
  const c = {
    endpoint: (process.env.ACCOUNTS_S3_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
    bucket: (process.env.ACCOUNTS_S3_BUCKET ?? "").trim(),
    region: (process.env.ACCOUNTS_S3_REGION ?? "auto").trim(),
    accessKeyId: (process.env.ACCOUNTS_S3_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: (process.env.ACCOUNTS_S3_SECRET_ACCESS_KEY ?? "").trim(),
  };
  if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey) {
    throw new Error("ACCOUNTS_STORAGE=s3 needs ACCOUNTS_S3_ENDPOINT, ACCOUNTS_S3_BUCKET, ACCOUNTS_S3_ACCESS_KEY_ID and ACCOUNTS_S3_SECRET_ACCESS_KEY.");
  }
  return c;
}

const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4, path-style (works with S3, R2, B2 and MinIO). */
async function s3Request(c: S3Config, method: "PUT" | "GET", key: string, body?: Buffer): Promise<Buffer> {
  const url = new URL(`${c.endpoint}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? "");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (body) headers["content-type"] = "application/octet-stream";
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [method, url.pathname, "", ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`), "", signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  const response = await fetch(url, { method, headers: { ...sendHeaders, authorization }, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Object storage ${method} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/* ------------------------------------------------------------------ API */

export interface PutFileInput {
  shopId: string;
  purpose: AccFile["purpose"];
  bytes: Buffer;
  contentType: string;
  originalName?: string | null;
  pageNo?: number | null;
  uploadedBy: string | null;
}

export async function putFile(input: PutFileInput, client: DbClient = db): Promise<AccFile> {
  if (input.bytes.length === 0) throw validationFailed("The file is empty.");
  if (input.bytes.length > MAX_FILE_BYTES) throw validationFailed(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  if (!ALLOWED_TYPES[input.contentType]) throw validationFailed("Upload a PDF, a photo (JPG/PNG/WEBP), an Excel sheet or an e-invoice JSON file.");
  const sha = sha256hex(input.bytes);
  const { body, encrypted } = encrypt(input.bytes);
  const name = randomBytes(16).toString("hex");
  const key = `shops/${input.shopId}/${name.slice(0, 2)}/${name}.bin`;
  let storage: AccFile["storage"] = "DB";
  let storageKey: string | null = null;
  let data: Buffer | null = body;

  const s3 = s3Config();
  if (s3) {
    await s3Request(s3, "PUT", key, body);
    storage = "S3";
    storageKey = key;
    data = null;
  } else {
    const root = mediaRoot();
    if (root) {
      const full = path.join(root, "accounts", ...key.split("/"));
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      const temp = `${full}.${process.pid}.tmp`;
      await writeFile(temp, body, { mode: 0o600, flag: "wx" });
      await rename(temp, full);
      storage = "DISK";
      storageKey = key;
      data = null;
    }
  }

  const [row] = await client
    .insert(accFiles)
    .values({
      shopId: input.shopId,
      purpose: input.purpose,
      originalName: input.originalName?.slice(0, 200) ?? null,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
      sha256: sha,
      storage,
      storageKey,
      data,
      encrypted,
      pageNo: input.pageNo ?? null,
      uploadedBy: input.uploadedBy,
    })
    .returning();
  return row;
}

const KEY_PATTERN = /^shops\/[0-9a-f-]{36}\/[0-9a-f]{2}\/[0-9a-f]{32}\.bin$/;

/** The file's bytes — only when it belongs to `shopId`. */
export async function readFileForShop(shopId: string, fileId: string): Promise<{ file: AccFile; bytes: Buffer }> {
  const [file] = await db.select().from(accFiles).where(and(eq(accFiles.id, fileId), eq(accFiles.shopId, shopId)));
  if (!file) throw notFound("File");
  return { file, bytes: await readBytes(file) };
}

export async function readBytes(file: AccFile): Promise<Buffer> {
  let stored: Buffer;
  if (file.storage === "DB") {
    if (!file.data) throw new Error("Stored file has no bytes.");
    stored = file.data;
  } else {
    if (!file.storageKey || !KEY_PATTERN.test(file.storageKey) || !file.storageKey.startsWith(`shops/${file.shopId}/`)) throw new Error("Invalid storage key.");
    if (file.storage === "S3") {
      const s3 = s3Config();
      if (!s3) throw new Error("This file is in object storage, but ACCOUNTS_STORAGE is not s3.");
      stored = await s3Request(s3, "GET", file.storageKey);
    } else {
      const root = mediaRoot();
      if (!root) throw new Error("This file is on disk, but MEDIA_DIR is not set.");
      stored = await readFile(path.join(root, "accounts", ...file.storageKey.split("/")));
    }
  }
  return decrypt(stored, file.encrypted);
}

export function storageDescription(): string {
  try {
    if (s3Config()) return "object storage (S3-compatible)";
  } catch {
    return "object storage (misconfigured)";
  }
  return mediaRoot() ? "server disk (MEDIA_DIR)" : "database";
}
