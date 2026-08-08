/**
 * objectStore.js — pluggable blob storage for large, non-financial objects (idea screenshots today).
 *
 * STOR-3 moved the base64 screenshot out of the hot `ideas` row into the `idea_screenshots` side table. This
 * module is the next step: an abstraction so the SAME callers can store the blob in real OBJECT STORAGE
 * (S3 / Cloudflare R2) instead of Postgres, keeping only a URL/key + metadata in the DB — the optimization
 * plan's "images and screenshots → object storage; PostgreSQL stores URL and metadata only."
 *
 * It is deliberately drop-in and env-gated:
 *   • DEFAULT (no config): mode "db" — the caller keeps using the Postgres side table exactly as today. Nothing
 *     changes, no new dependency, no creds required.
 *   • OPT-IN: set OBJECT_STORE=s3 plus the S3/R2 env below and `npm i @aws-sdk/client-s3`. Then blobs are written
 *     to the bucket and the DB stores only the object key. Enabling is a config + one dependency — no code change.
 *
 * The AWS SDK is loaded LAZILY (require only when s3 mode is actually used), so the default install needs no
 * extra package. Screenshots are cosmetic and non-financial, so every path here is best-effort and never blocks
 * a money operation.
 *
 * S3/R2 env:
 *   OBJECT_STORE=s3
 *   S3_BUCKET=...            (required)
 *   S3_REGION=auto|us-east-1 (R2 uses "auto")
 *   S3_ENDPOINT=...          (R2: https://<account>.r2.cloudflarestorage.com ; omit for AWS S3)
 *   S3_ACCESS_KEY_ID=...     S3_SECRET_ACCESS_KEY=...
 *   S3_PREFIX=ideas/         (optional key prefix)
 */

const MODE = (process.env.OBJECT_STORE || "db").toLowerCase();
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_PREFIX = process.env.S3_PREFIX || "ideas/";

/** True when S3/R2 is fully configured and selected. Callers use this to decide db-side-table vs object store. */
function s3Enabled() {
  return MODE === "s3" && !!S3_BUCKET && !!process.env.S3_ACCESS_KEY_ID && !!process.env.S3_SECRET_ACCESS_KEY;
}
/** Which backend is active: "s3" when configured, else "db" (Postgres side table — the default). */
function mode() { return s3Enabled() ? "s3" : "db"; }

let _client = null;
function client() {
  if (_client) return _client;
  // Lazy — only require the SDK when S3 mode is actually exercised, so the default install needs no dependency.
  const { S3Client } = require("@aws-sdk/client-s3");
  _client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    forcePathStyle: !!process.env.S3_ENDPOINT, // R2 / MinIO want path-style
  });
  return _client;
}

const keyFor = (id) => `${S3_PREFIX}${String(id)}`;

/* A data-URL is "data:<contentType>;base64,<payload>". Split it so S3 stores raw bytes + the right content type,
   and reads can reconstruct the exact data-URL the client already expects. */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!m) return { contentType: "application/octet-stream", buffer: Buffer.from(String(dataUrl || ""), "utf8"), isBase64: false };
  const contentType = m[1] || "application/octet-stream";
  const isBase64 = !!m[2];
  const buffer = isBase64 ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { contentType, buffer, isBase64 };
}

/** Store a screenshot data-URL. Returns { key } on S3, or null in db mode (caller uses the side table). */
async function putScreenshot(id, dataUrl) {
  if (!s3Enabled()) return null;
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const { contentType, buffer } = parseDataUrl(dataUrl);
  const Key = keyFor(id);
  await client().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key, Body: buffer, ContentType: contentType }));
  return { key: Key, contentType, bytes: buffer.length };
}

/** Fetch a screenshot back as a data-URL string (what the client renders). null if absent / db mode. */
async function getScreenshot(id) {
  if (!s3Enabled()) return null;
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  try {
    const out = await client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: keyFor(id) }));
    const chunks = [];
    for await (const c of out.Body) chunks.push(c);
    const b64 = Buffer.concat(chunks).toString("base64");
    return `data:${out.ContentType || "image/png"};base64,${b64}`;
  } catch { return null; }
}

/** Delete a screenshot object. Best-effort. */
async function deleteScreenshot(id) {
  if (!s3Enabled()) return;
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  try { await client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: keyFor(id) })); } catch { /* best-effort */ }
}

module.exports = { mode, s3Enabled, putScreenshot, getScreenshot, deleteScreenshot, keyFor, parseDataUrl };
