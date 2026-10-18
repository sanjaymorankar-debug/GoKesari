/**
 * ObjectStore — where imported product images (and other PMD files) are kept
 * (batch-2026-10 WS-D, F9.1.4).
 *
 *   getObjectStore() → PlatformObjectStore   default: the platform's own store — the bytes in
 *                                            pmd_object_blobs, or a file under MEDIA_DIR exactly
 *                                            as the existing blob store does (media/blob-store.ts)
 *                    → S3ObjectStore         an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO,
 *                                            DigitalOcean Spaces…) when rule objectStore.s3Enabled
 *                                            is on AND every OBJECT_STORE_* variable is set
 *
 * Keys are made here (random, sharded), never taken from a user or a URL.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { pmdObjectBlobs } from "@/server/db/schema";
import { putBlob, readBlob, type BlobExtension } from "@/server/media/blob-store";
import { getRule } from "@/server/services/settings";

export interface StoredObject {
  store: string;
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface ObjectStore {
  readonly name: "PLATFORM" | "S3";
  isConfigured(): boolean;
  put(input: { prefix: string; bytes: Buffer; contentType: string; extension: string }): Promise<StoredObject>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9/_-]{0,80}\/[0-9a-f]{2}\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/;

export function newObjectKey(prefix: string, extension: string): string {
  const clean = prefix.toLowerCase().replace(/[^a-z0-9/_-]/g, "-").replace(/^\/+|\/+$/g, "") || "pmd";
  const name = randomBytes(16).toString("hex");
  return `${clean}/${name.slice(0, 2)}/${name}.${extension.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/* ------------------------------------------------------------- platform */

export class PlatformObjectStore implements ObjectStore {
  readonly name = "PLATFORM" as const;
  isConfigured(): boolean {
    return true;
  }

  async put(input: { prefix: string; bytes: Buffer; contentType: string; extension: string }): Promise<StoredObject> {
    const key = newObjectKey(input.prefix, input.extension);
    // The blob store keeps webp / csv / zip on disk when MEDIA_DIR is set; anything else stays in the row.
    const diskable = ["webp", "csv", "zip"].includes(input.extension);
    const blob = diskable ? await putBlob(input.bytes, input.extension as BlobExtension) : { storage: "DB" as const, storageKey: null, data: input.bytes };
    await db.insert(pmdObjectBlobs).values({
      key,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
      storage: blob.storage,
      storageKey: blob.storageKey,
      data: blob.data,
    });
    return { store: this.name, key, sizeBytes: input.bytes.length, contentType: input.contentType };
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    if (!KEY.test(key)) return null;
    const [row] = await db.select().from(pmdObjectBlobs).where(eq(pmdObjectBlobs.key, key));
    if (!row) return null;
    const bytes = await readBlob({ storage: row.storage, storageKey: row.storageKey, data: row.data ?? null });
    return { bytes, contentType: row.contentType };
  }

  async delete(key: string): Promise<void> {
    await db.delete(pmdObjectBlobs).where(eq(pmdObjectBlobs.key, key));
  }
}

/* ------------------------------------------------------------ S3 (scaffold) */

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.OBJECT_STORE_ENDPOINT?.trim();
  const bucket = env.OBJECT_STORE_BUCKET?.trim();
  const region = env.OBJECT_STORE_REGION?.trim() || "auto";
  const accessKeyId = env.OBJECT_STORE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OBJECT_STORE_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, region, accessKeyId, secretAccessKey };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/**
 * S3-compatible store, path-style requests signed with AWS Signature V4.
 * A scaffold: written to the published SigV4 rules but not yet exercised
 * against a real bucket — switch it on in staging first.
 */
export class S3ObjectStore implements ObjectStore {
  readonly name = "S3" as const;
  constructor(
    private readonly config: S3Config | null = s3ConfigFromEnv(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config !== null;
  }

  private signed(method: "PUT" | "GET" | "DELETE", key: string, body: Buffer | null, contentType?: string): { url: string; headers: Record<string, string> } {
    const c = this.config;
    if (!c) throw new Error("Object store is not configured (OBJECT_STORE_* variables).");
    const url = new URL(`${c.endpoint}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? "");
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${c.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    delete headers.host;
    return { url: url.toString(), headers };
  }

  async put(input: { prefix: string; bytes: Buffer; contentType: string; extension: string }): Promise<StoredObject> {
    const key = newObjectKey(input.prefix, input.extension);
    const { url, headers } = this.signed("PUT", key, input.bytes, input.contentType);
    const res = await this.fetchFn(url, { method: "PUT", headers, body: new Uint8Array(input.bytes) });
    if (!res.ok) throw new Error(`Object store refused the upload (${res.status}).`);
    return { store: this.name, key, sizeBytes: input.bytes.length, contentType: input.contentType };
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    if (!KEY.test(key)) return null;
    const { url, headers } = this.signed("GET", key, null);
    const res = await this.fetchFn(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Object store read failed (${res.status}).`);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = this.signed("DELETE", key, null);
    await this.fetchFn(url, { method: "DELETE", headers });
  }
}

/** The store new objects go to. S3 only when the rule is on and it is configured; otherwise the platform store. */
export async function getObjectStore(): Promise<ObjectStore> {
  const rule = await getRule("objectStore");
  if (rule.s3Enabled) {
    const s3 = new S3ObjectStore();
    if (s3.isConfigured()) return s3;
    console.warn("[pmd] objectStore.s3Enabled is on but OBJECT_STORE_* is not set — using the platform store.");
  }
  return new PlatformObjectStore();
}

/** Reads an object from whichever store a row says holds it. */
export async function readObject(store: string | null, key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (store === "S3") return new S3ObjectStore().get(key);
  return new PlatformObjectStore().get(key);
}
