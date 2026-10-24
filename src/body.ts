import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { BodyEncoding, HeaderMap } from "./types.js";
import { isJsonMedia, mediaType } from "./util.js";

export interface InterpretedBody {
  body: unknown;
  bodyEncoding: BodyEncoding;
  contentType?: string;
}

export function decodeCompressed(buf: Buffer, encoding: string | undefined): Buffer {
  const value = (encoding ?? "").toLowerCase();
  if (!value || value === "identity") return buf;
  if (value.includes("gzip")) return gunzipSync(buf);
  if (value.includes("br")) return brotliDecompressSync(buf);
  if (value.includes("deflate")) return inflateSync(buf);
  return buf;
}

export function interpretBody(buf: Buffer, contentType: string | undefined): InterpretedBody {
  if (buf.length === 0) return { body: null, bodyEncoding: "empty" };
  const media = mediaType(contentType);
  if (isJsonMedia(media)) {
    try {
      return { body: JSON.parse(buf.toString("utf8")) as unknown, bodyEncoding: "json", contentType: media };
    } catch {
      return { body: buf.toString("utf8"), bodyEncoding: "text", contentType: media };
    }
  }
  if (media === "application/x-www-form-urlencoded") {
    return { body: parseForm(buf.toString("utf8")), bodyEncoding: "form", contentType: media };
  }
  if (media.startsWith("text/") || media === "application/xml" || media.endsWith("+xml") || media === "application/javascript") {
    return { body: buf.toString("utf8"), bodyEncoding: "text", contentType: media };
  }
  if (!media) {
    const text = buf.toString("utf8");
    const trimmed = text.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return { body: JSON.parse(text) as unknown, bodyEncoding: "json" };
      } catch {
        /* fall through */
      }
    }
    if (isMostlyText(buf)) return { body: text, bodyEncoding: "text" };
  }
  return {
    body: buf.toString("base64"),
    bodyEncoding: "bytes",
    contentType: media || "application/octet-stream",
  };
}

function parseForm(text: string): Record<string, string | string[]> {
  const params = new URLSearchParams(text);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const current = out[key];
    if (current === undefined) out[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else out[key] = [current, value];
  }
  return out;
}

function isMostlyText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  let suspicious = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) suspicious += 1;
  }
  return suspicious / sample.length < 0.1;
}

export function flattenHeaders(headers: Record<string, string | string[] | undefined>): HeaderMap {
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function encodeBody(body: unknown, encoding: BodyEncoding): Buffer {
  if (encoding === "empty" || body === null || body === undefined) return Buffer.alloc(0);
  if (encoding === "json") return Buffer.from(JSON.stringify(body));
  if (encoding === "bytes" && typeof body === "string") return Buffer.from(body, "base64");
  if (encoding === "form" && body && typeof body === "object" && !Array.isArray(body)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else if (value !== undefined && value !== null) params.append(key, String(value));
    }
    return Buffer.from(params.toString());
  }
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}

export function headerContentType(headers: HeaderMap, encoding: BodyEncoding, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (headers["content-type"]) return headers["content-type"];
  if (encoding === "json") return "application/json; charset=utf-8";
  if (encoding === "text") return "text/plain; charset=utf-8";
  if (encoding === "form") return "application/x-www-form-urlencoded";
  if (encoding === "bytes") return "application/octet-stream";
  return undefined;
}
