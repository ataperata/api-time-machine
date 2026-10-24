import { createHash, randomBytes } from "node:crypto";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Stable JSON used for hashing and equality. Object keys are sorted. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(",")}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function mediaType(contentType: string | undefined): string {
  if (!contentType) return "";
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isJsonMedia(media: string): boolean {
  return media === "application/json" || media.endsWith("+json");
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function compareCursor(
  a: { seq?: number; recordedAt: string; id: string },
  b: { seq?: number; recordedAt: string; id: string },
): number {
  const aSeq = a.seq ?? 0;
  const bSeq = b.seq ?? 0;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function countOperations(paths: Record<string, Record<string, unknown>>): number {
  let n = 0;
  for (const methods of Object.values(paths)) n += Object.keys(methods).length;
  return n;
}

export function methodRank(method: string): number {
  const order = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
  const idx = order.indexOf(method.toLowerCase());
  return idx === -1 ? order.length : idx;
}

export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new UsageError(`Invalid id: ${id}`);
  }
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError(`Invalid port: ${value}`);
  }
  return n;
}

/** Drop vendor extensions, descriptions, and examples so hashes track the contract. */
export function stripNonContract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNonContract(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key.startsWith("x-")) continue;
    if (key === "description" || key === "example" || key === "examples" || key === "summary") {
      continue;
    }
    out[key] = stripNonContract((value as Record<string, unknown>)[key]);
  }
  return out;
}
