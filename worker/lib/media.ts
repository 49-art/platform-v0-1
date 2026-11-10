/**
 * Private media store (spec 11: "R2 private buckets, signed URLs").
 *
 * R2 is the production store. The free sample has no R2 bucket (enabling R2 needs a payment card on the
 * Cloudflare account), so the same three operations fall back to a D1 table of blobs (decision D-015).
 * Photos are resized on the device before upload, so each blob stays well under D1's 1 MB row limit.
 * Callers never touch a bucket directly: everything goes through put / get / remove.
 */
import type { Env } from "../env";

export interface StoredMedia {
  body: ReadableStream | ArrayBuffer;
  contentType: string;
}

export async function putMedia(env: Env, key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  if (env.MEDIA) {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
    return;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO media_blobs (key, content_type, bytes, created_at) VALUES (?1, ?2, ?3, ?4)").bind(key, contentType, bytes, Date.now()).run();
}

export async function getMedia(env: Env, key: string): Promise<StoredMedia | null> {
  if (env.MEDIA) {
    const obj = await env.MEDIA.get(key);
    return obj ? { body: obj.body, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" } : null;
  }
  const row = await env.DB.prepare("SELECT content_type, bytes FROM media_blobs WHERE key = ?1").bind(key).first<{ content_type: string; bytes: ArrayBuffer | number[] }>();
  if (!row) return null;
  // D1 hands BLOB columns back as an array of byte values, not an ArrayBuffer.
  const body = row.bytes instanceof ArrayBuffer ? row.bytes : new Uint8Array(row.bytes).buffer;
  return { body, contentType: row.content_type };
}

export async function removeMedia(env: Env, key: string): Promise<void> {
  if (env.MEDIA) {
    await env.MEDIA.delete(key);
    return;
  }
  await env.DB.prepare("DELETE FROM media_blobs WHERE key = ?1").bind(key).run();
}
