/** Shared contract types for recordings, specs, and diffs. */

export type BodyEncoding = "json" | "text" | "form" | "bytes" | "empty";

export type QueryValue = string | string[];

export type QueryMap = Record<string, QueryValue>;

/** Lower-cased header names. */
export type HeaderMap = Record<string, string>;

export interface ExchangeRequest {
  method: string;
  path: string;
  query: QueryMap;
  headers: HeaderMap;
  body: unknown;
  bodyEncoding: BodyEncoding;
  contentType?: string;
}

export interface ExchangeResponse {
  status: number;
  headers: HeaderMap;
  body: unknown;
  bodyEncoding: BodyEncoding;
  contentType?: string;
  durationMs: number;
}

/**
 * One captured HTTP exchange. `seq` is a store-wide monotonic cursor used to
 * slice inference windows. Hand-written fixtures may omit it.
 */
export interface Exchange {
  id: string;
  seq?: number;
  recordedAt: string;
  sessionId: string;
  request: ExchangeRequest;
  response: ExchangeResponse;
  truncated?: boolean;
}

export interface SessionHeader {
  _atm: "header";
  format: 1;
  sessionId: string;
  name?: string;
  upstream?: string;
  startedAt: string;
  redaction: {
    builtins: boolean;
    replacement: string;
    extraHeaders: number;
    extraKeys: number;
    extraPatterns: number;
  };
}

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: unknown[];
  example?: unknown;
  description?: string;
  contentEncoding?: string;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: JsonSchema;
  example?: unknown;
  description?: string;
}

export interface OpenApiMediaType {
  schema?: JsonSchema;
  example?: unknown;
}

export interface OpenApiRequestBody {
  required?: boolean;
  description?: string;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  "x-atm"?: {
    samples: number;
    statuses: Record<string, number>;
    firstSeen: string;
    lastSeen: string;
  };
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface VersionInfo {
  id: string;
  createdAt: string;
  hash: string;
  exchangeCount: number;
  sessionIds: string[];
  operationCount: number;
  title: string;
  file: string;
  fromSeq: number;
  throughSeq: number;
  source: "incremental" | "all" | "session";
}

export type ChangeLevel = "breaking" | "warning" | "info";

export interface Change {
  level: ChangeLevel;
  kind: string;
  operation: string;
  pointer: string;
  message: string;
}

export interface DiffReport {
  from: { id: string; createdAt?: string; hash?: string };
  to: { id: string; createdAt?: string; hash?: string };
  changes: Change[];
  summary: { breaking: number; warning: number; info: number };
}

export interface ValuePattern {
  name: string;
  pattern: string;
  flags?: string;
}

export interface RedactionConfig {
  replacement: string;
  /** When false, built-in secret/PII rules are not applied. */
  builtins: boolean;
  headers: string[];
  headerPatterns: string[];
  queryParams: string[];
  jsonKeys: string[];
  jsonKeyPatterns: string[];
  valuePatterns: ValuePattern[];
}

export type ReplayMode = "strict" | "fuzzy" | "path";

export type PreferOrder = "newest" | "oldest";
