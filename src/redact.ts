import type { Exchange, HeaderMap, QueryMap, RedactionConfig, ValuePattern } from "./types.js";
import { mediaType } from "./util.js";

const REPLACEMENT_DEFAULT = "[REDACTED]";

const BUILTIN_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
];

const BUILTIN_QUERY = ["token", "access_token", "refresh_token", "api_key", "apikey", "key"];

const SENSITIVE_PARTS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "ssn",
  "cvv",
  "cvc",
  "apikey",
  "authorization",
  "credential",
  "credentials",
]);

const BUILTIN_VALUE_PATTERNS: ValuePattern[] = [
  {
    name: "email",
    pattern: "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b",
    flags: "gi",
  },
  {
    name: "ssn",
    pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    flags: "g",
  },
  {
    name: "jwt",
    pattern: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
    flags: "g",
  },
];

export function defaultRedactionConfig(): RedactionConfig {
  return {
    replacement: REPLACEMENT_DEFAULT,
    builtins: true,
    headers: [...BUILTIN_HEADERS],
    headerPatterns: [],
    queryParams: [...BUILTIN_QUERY],
    jsonKeys: [],
    jsonKeyPatterns: [],
    valuePatterns: BUILTIN_VALUE_PATTERNS.map((pattern) => ({ ...pattern })),
  };
}

export function emptyRedactionConfig(): RedactionConfig {
  return {
    replacement: REPLACEMENT_DEFAULT,
    builtins: false,
    headers: [],
    headerPatterns: [],
    queryParams: [],
    jsonKeys: [],
    jsonKeyPatterns: [],
    valuePatterns: [],
  };
}

interface RedactionFile {
  replacement?: string;
  builtins?: boolean;
  headers?: string[];
  headerPatterns?: string[];
  queryParams?: string[];
  jsonKeys?: string[];
  jsonKeyPatterns?: string[];
  valuePatterns?: ValuePattern[];
}

export function redactionFromJson(raw: unknown): RedactionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Redaction config must be a JSON object");
  }
  const file = raw as RedactionFile;
  const base = file.builtins === false ? emptyRedactionConfig() : defaultRedactionConfig();
  const config: RedactionConfig = {
    replacement: file.replacement ?? base.replacement,
    builtins: file.builtins !== false,
    headers: dedupe([...base.headers, ...(file.headers ?? [])]),
    headerPatterns: dedupe([...base.headerPatterns, ...(file.headerPatterns ?? [])]),
    queryParams: dedupe([...base.queryParams, ...(file.queryParams ?? [])]),
    jsonKeys: dedupe([...base.jsonKeys, ...(file.jsonKeys ?? [])]),
    jsonKeyPatterns: dedupe([...base.jsonKeyPatterns, ...(file.jsonKeyPatterns ?? [])]),
    valuePatterns: [...base.valuePatterns, ...(file.valuePatterns ?? [])],
  };
  compileRedaction(config);
  return config;
}

export interface CompiledRedaction {
  config: RedactionConfig;
  headerPatterns: RegExp[];
  keyPatterns: RegExp[];
  extraKeys: Set<string>;
  queryKeys: Set<string>;
  headerNames: Set<string>;
  valuePatterns: Array<{ name: string; regex: RegExp }>;
}

export function compileRedaction(config: RedactionConfig): CompiledRedaction {
  return {
    config,
    headerPatterns: config.headerPatterns.map((pattern) => compile(pattern, "i")),
    keyPatterns: config.jsonKeyPatterns.map((pattern) => compile(pattern, "i")),
    extraKeys: new Set(config.jsonKeys.map((key) => key.toLowerCase())),
    queryKeys: new Set(config.queryParams.map((key) => key.toLowerCase())),
    headerNames: new Set(config.headers.map((key) => key.toLowerCase())),
    valuePatterns: config.valuePatterns.map((pattern) => ({
      name: pattern.name,
      regex: compile(pattern.pattern, pattern.flags ?? "g"),
    })),
  };
}

function compile(pattern: string, flags: string): RegExp {
  try {
    const withGlobal = flags.includes("g") ? flags : `${flags}g`;
    return new RegExp(pattern, withGlobal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid redaction regex /${pattern}/: ${message}`);
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

export function isSensitiveKey(key: string, compiled: CompiledRedaction): boolean {
  if (compiled.extraKeys.has(key.toLowerCase())) return true;
  if (compiled.keyPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  })) {
    return true;
  }
  if (!compiled.config.builtins) return false;
  const parts = keyParts(key);
  if (parts.some((part) => SENSITIVE_PARTS.has(part))) return true;
  const joined = parts.join("");
  return (
    joined.includes("apikey") ||
    joined.includes("creditcard") ||
    joined.includes("privatekey") ||
    joined.includes("clientsecret") ||
    joined.includes("accesstoken") ||
    joined.includes("refreshtoken") ||
    joined.includes("cardnumber")
  );
}

function isSensitiveHeader(name: string, compiled: CompiledRedaction): boolean {
  const lower = name.toLowerCase();
  if (compiled.headerNames.has(lower)) return true;
  if (compiled.headerPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(lower);
  })) {
    return true;
  }
  if (!compiled.config.builtins) return false;
  return isSensitiveKey(lower, compiled);
}

function isSensitiveQuery(name: string, compiled: CompiledRedaction): boolean {
  if (compiled.queryKeys.has(name.toLowerCase())) return true;
  return isSensitiveKey(name, compiled);
}

export function redactString(input: string, compiled: CompiledRedaction): string {
  let value = input;
  for (const pattern of compiled.valuePatterns) {
    pattern.regex.lastIndex = 0;
    value = value.replace(pattern.regex, compiled.config.replacement);
  }
  if (!compiled.config.builtins) return value;
  return redactCreditCards(value, compiled.config.replacement);
}

export function redactCreditCards(input: string, replacement: string): string {
  return input.replace(/\d[\d -]{11,22}\d/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhn(digits) ? replacement : match;
  });
}

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function redactValue(value: unknown, compiled: CompiledRedaction): unknown {
  if (typeof value === "string") return redactString(value, compiled);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, compiled));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key, compiled)) out[key] = compiled.config.replacement;
      else out[key] = redactValue(child, compiled);
    }
    return out;
  }
  return value;
}

export function redactHeaders(headers: HeaderMap, compiled: CompiledRedaction): HeaderMap {
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = isSensitiveHeader(key, compiled)
      ? compiled.config.replacement
      : redactString(value, compiled);
  }
  return out;
}

export function redactQuery(query: QueryMap, compiled: CompiledRedaction): QueryMap {
  const out: QueryMap = {};
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    if (isSensitiveQuery(key, compiled)) {
      out[key] = compiled.config.replacement;
      continue;
    }
    out[key] = Array.isArray(value)
      ? value.map((item) => redactString(item, compiled))
      : redactString(value, compiled);
  }
  return out;
}

function redactBody(
  body: unknown,
  encoding: Exchange["request"]["bodyEncoding"],
  compiled: CompiledRedaction,
): unknown {
  if (encoding === "empty" || body === null || body === undefined) return body ?? null;
  if (encoding === "json" || encoding === "form") return redactValue(body, compiled);
  if (encoding === "text" && typeof body === "string") return redactString(body, compiled);
  return body;
}

export function redactExchange(exchange: Exchange, config: RedactionConfig = defaultRedactionConfig()): Exchange {
  const compiled = compileRedaction(config);
  return {
    ...exchange,
    request: {
      ...exchange.request,
      headers: redactHeaders(exchange.request.headers, compiled),
      query: redactQuery(exchange.request.query, compiled),
      body: redactBody(exchange.request.body, exchange.request.bodyEncoding, compiled),
    },
    response: {
      ...exchange.response,
      headers: redactHeaders(exchange.response.headers, compiled),
      body: redactBody(exchange.response.body, exchange.response.bodyEncoding, compiled),
    },
  };
}

export function contentTypeOf(headers: HeaderMap): string {
  return mediaType(headers["content-type"]);
}
