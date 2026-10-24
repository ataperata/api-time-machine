import type { QueryMap, QueryValue } from "./types.js";

/**
 * Join a pinned upstream base URL with an incoming request-target.
 * The upstream origin always wins: protocol-relative targets cannot retarget the host.
 */
export function buildUpstreamUrl(upstream: string, rawUrl: string): string {
  const base = new URL(upstream);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`Unsupported upstream protocol: ${base.protocol}`);
  }
  const { path, search } = splitRequestTarget(rawUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  let pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  const joined = new URL(base.origin);
  joined.pathname = pathname;
  joined.search = search;
  return joined.toString();
}

export function splitRequestTarget(rawUrl: string): { path: string; search: string } {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    const abs = new URL(rawUrl);
    return { path: abs.pathname || "/", search: abs.search };
  }
  if (!rawUrl.startsWith("/")) {
    throw new Error(`Invalid request target: ${rawUrl}`);
  }
  const q = rawUrl.indexOf("?");
  if (q === -1) return { path: rawUrl, search: "" };
  return { path: rawUrl.slice(0, q) || "/", search: rawUrl.slice(q) };
}

export function parseQuery(search: string): QueryMap {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const map: Record<string, QueryValue> = {};
  for (const [key, value] of params.entries()) {
    const current = map[key];
    if (current === undefined) map[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else map[key] = [current, value];
  }
  const sorted: QueryMap = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

export function queryPairs(query: QueryMap): string[] {
  const pairs: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? [...value].sort() : [value];
    for (const item of values) pairs.push(`${key}=${item}`);
  }
  return pairs;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}
