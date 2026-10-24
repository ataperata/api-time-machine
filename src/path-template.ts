/**
 * Infer REST path templates from concrete paths.
 *
 * Strong identifiers (integers, UUIDs, ULIDs, ObjectIds, long tokens) always
 * become parameters, even from a single sample. Literal segments stay literal
 * unless a plural collection parent shows high cardinality (word-like ids such
 * as usernames). Low-cardinality words (`/pets/dogs`, `/pets/cats`) and known
 * aliases (`/users/me`) stay distinct routes so they are not swallowed by a
 * neighbouring id template.
 */

const LITERAL_PARAM_MIN_UNIQUE = 4;
const LITERAL_PARAM_MIN_RATIO = 0.5;
const GLOBAL_LITERAL_PARAM_MIN_UNIQUE = 8;

const UNCOUNTABLE = new Set([
  "metrics",
  "series",
  "status",
  "news",
  "settings",
  "auth",
  "api",
  "health",
  "info",
  "data",
  "metadata",
  "ops",
]);

const KNOWN_ALIASES = new Set([
  "me",
  "self",
  "current",
  "new",
  "search",
  "count",
  "login",
  "logout",
  "health",
  "status",
  "metadata",
  "all",
  "index",
  "default",
  "latest",
  "first",
  "last",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export type SegmentKind = "static" | "param";

export interface CompiledTemplate {
  template: string;
  paramNames: string[];
  regex: RegExp;
  paramCount: number;
  staticLength: number;
}

export interface ResolvedPath {
  template: string;
  params: Record<string, string>;
}

export interface PathModel {
  templates: CompiledTemplate[];
  resolve(path: string): ResolvedPath;
}

interface MarkedPath {
  segments: string[];
  kinds: SegmentKind[];
}

export function normalizePath(input: string): string {
  const withoutQuery = input.split("?")[0] ?? "/";
  let path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const segments = path.split("/");
  const decoded = segments.map((segment) => {
    if (!segment) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  path = decoded.join("/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

export function splitSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/") return [];
  return normalized.split("/").filter((segment) => segment.length > 0);
}

export function isStrongId(segment: string): boolean {
  if (/^\d{4}$/.test(segment)) {
    const year = Number(segment);
    if (year >= 1900 && year <= 2100) return false;
  }
  if (/^\d{1,19}$/.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (ULID_RE.test(segment)) return true;
  if (OBJECT_ID_RE.test(segment)) return true;
  if (/^[a-f0-9]{16,64}$/i.test(segment)) return true;
  if (segment.length >= 20 && /[0-9]/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)) {
    return true;
  }
  return false;
}

export function singularize(word: string): string {
  const value = word.toLowerCase();
  if (UNCOUNTABLE.has(value)) return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(value) && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) return value.slice(0, -1);
  return value;
}

export function isPluralResource(word: string): boolean {
  const value = word.toLowerCase();
  if (UNCOUNTABLE.has(value)) return false;
  return singularize(value) !== value;
}

function isKnownAlias(segment: string): boolean {
  return KNOWN_ALIASES.has(segment.toLowerCase());
}

function shouldParameterizeLiterals(values: string[], prev: string | null): boolean {
  const unique = new Set(values);
  if (unique.size <= 1) return false;
  if ([...unique].every((value) => isKnownAlias(value))) return false;
  const ratio = unique.size / values.length;
  if (
    prev &&
    isPluralResource(prev) &&
    unique.size >= LITERAL_PARAM_MIN_UNIQUE &&
    ratio >= LITERAL_PARAM_MIN_RATIO &&
    ![...unique].some((value) => isKnownAlias(value))
  ) {
    return true;
  }
  return unique.size >= GLOBAL_LITERAL_PARAM_MIN_UNIQUE && ratio >= LITERAL_PARAM_MIN_RATIO;
}

function commonPrev(paths: string[][], col: number, kinds: SegmentKind[]): string | null {
  if (col === 0 || kinds[col - 1] !== "static") return null;
  const first = paths[0]?.[col - 1];
  if (first === undefined) return null;
  for (const segments of paths) {
    if (segments[col - 1] !== first) return null;
  }
  return first;
}

function refine(paths: string[][], col: number, kinds: SegmentKind[]): MarkedPath[] {
  const length = paths[0]?.length ?? 0;
  if (col >= length) {
    return paths.map((segments) => ({ segments, kinds }));
  }
  const ids: string[][] = [];
  const literals: string[][] = [];
  for (const segments of paths) {
    const value = segments[col] ?? "";
    if (isStrongId(value)) ids.push(segments);
    else literals.push(segments);
  }
  const out: MarkedPath[] = [];
  if (ids.length > 0) out.push(...refine(ids, col + 1, [...kinds, "param"]));
  if (literals.length > 0) {
    const prev = commonPrev(literals, col, kinds);
    const values = literals.map((segments) => segments[col] ?? "");
    if (shouldParameterizeLiterals(values, prev)) {
      out.push(...refine(literals, col + 1, [...kinds, "param"]));
    } else {
      const groups = new Map<string, string[][]>();
      for (const segments of literals) {
        const key = segments[col] ?? "";
        const bucket = groups.get(key);
        if (bucket) bucket.push(segments);
        else groups.set(key, [segments]);
      }
      for (const bucket of groups.values()) {
        out.push(...refine(bucket, col + 1, [...kinds, "static"]));
      }
    }
  }
  return out;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}${index}`)) index += 1;
  const name = `${base}${index}`;
  used.add(name);
  return name;
}

function nameParams(segments: string[], kinds: SegmentKind[]): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (kinds[i] !== "param") {
      names.push("");
      continue;
    }
    let prev: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (kinds[j] === "static") {
        prev = segments[j] ?? null;
        break;
      }
    }
    const base = prev ? `${singularize(prev)}Id` : "id";
    names.push(uniqueName(base, used));
  }
  return names;
}

function templateKey(marked: MarkedPath): string {
  return marked.segments
    .map((segment, index) => (marked.kinds[index] === "param" ? "\u0000" : segment))
    .join("/");
}

function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileTemplate(template: string, paramNames: string[]): CompiledTemplate {
  const parts = template === "/" ? [] : template.split("/").filter((part) => part.length > 0);
  const body = parts
    .map((part) => (part.startsWith("{") && part.endsWith("}") ? "([^/]+)" : escapeRegExp(part)))
    .join("/");
  const regex = new RegExp(body.length === 0 ? "^/$" : `^/${body}$`);
  const staticLength = parts
    .filter((part) => !(part.startsWith("{") && part.endsWith("}")))
    .join("/").length;
  return {
    template,
    paramNames,
    regex,
    paramCount: paramNames.length,
    staticLength,
  };
}

export function learnPaths(paths: string[]): PathModel {
  const byLength = new Map<number, string[][]>();
  for (const path of paths) {
    const segments = splitSegments(path);
    const bucket = byLength.get(segments.length);
    if (bucket) bucket.push(segments);
    else byLength.set(segments.length, [segments]);
  }

  const groups = new Map<string, MarkedPath>();
  for (const bucket of byLength.values()) {
    if (bucket.length === 0) continue;
    for (const marked of refine(bucket, 0, [])) {
      const key = `${marked.segments.length}:${templateKey(marked)}`;
      if (!groups.has(key)) groups.set(key, marked);
    }
  }

  const templates: CompiledTemplate[] = [];
  for (const marked of groups.values()) {
    const names = nameParams(marked.segments, marked.kinds);
    const template =
      marked.segments.length === 0
        ? "/"
        : `/${marked.segments
            .map((segment, index) => (marked.kinds[index] === "param" ? `{${names[index]}}` : segment))
            .join("/")}`;
    const paramNames = names.filter((name) => name.length > 0);
    templates.push(compileTemplate(template, paramNames));
  }
  templates.sort((a, b) => compareCodePoints(a.template, b.template));

  return {
    templates,
    resolve(path: string): ResolvedPath {
      const normalized = normalizePath(path);
      const matches = templates.filter((template) => template.regex.test(normalized));
      matches.sort(
        (a, b) =>
          a.paramCount - b.paramCount ||
          b.staticLength - a.staticLength ||
          compareCodePoints(a.template, b.template),
      );
      const winner = matches[0];
      if (!winner) return { template: normalized, params: {} };
      const matched = winner.regex.exec(normalized);
      const params: Record<string, string> = {};
      winner.paramNames.forEach((name, index) => {
        const value = matched?.[index + 1];
        if (value !== undefined) params[name] = value;
      });
      return { template: winner.template, params };
    },
  };
}
