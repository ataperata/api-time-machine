import type {
  Exchange,
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  VersionInfo,
} from "./types.js";
import { learnPaths, type PathModel } from "./path-template.js";
import { coerceScalar, inferSchema } from "./schema.js";
import { RecordingStore } from "./store.js";
import { isJsonMedia, mediaType, methodRank, UsageError } from "./util.js";

export interface InferOptions {
  title?: string;
  version?: string;
}

interface Group {
  method: string;
  template: string;
  exchanges: Exchange[];
}

/**
 * Build an OpenAPI 3.1 document from a single traffic window.
 * Schemas are inlined (no components) so later diffs compare structure, not names.
 */
export function inferOpenApi(exchanges: Exchange[], options: InferOptions = {}): OpenApiDocument {
  const model = learnPaths(exchanges.map((exchange) => exchange.request.path));
  const groups = new Map<string, Group>();
  for (const exchange of exchanges) {
    const method = exchange.request.method.toUpperCase();
    const resolved = model.resolve(exchange.request.path);
    const key = `${method} ${resolved.template}`;
    let group = groups.get(key);
    if (!group) {
      group = { method, template: resolved.template, exchanges: [] };
      groups.set(key, group);
    }
    group.exchanges.push(exchange);
  }

  const paths: OpenApiDocument["paths"] = {};
  const ordered = [...groups.values()].sort(
    (a, b) => a.template.localeCompare(b.template) || methodRank(a.method) - methodRank(b.method),
  );
  for (const group of ordered) {
    const pathItem = paths[group.template] ?? {};
    pathItem[group.method.toLowerCase()] = buildOperation(group, model);
    paths[group.template] = pathItem;
  }

  const title = options.title ?? "Inferred API";
  return {
    openapi: "3.1.0",
    info: {
      title,
      version: options.version ?? "0.0.0",
      description: `Inferred by api-time-machine from ${exchanges.length} exchange(s). Schemas inline observed samples; a field is required only when it appears in every object sample of this window.`,
    },
    servers: [{ url: "/" }],
    paths,
  };
}

function buildOperation(group: Group, model: PathModel): OpenApiOperation {
  const samples = group.exchanges.length;
  const statuses: Record<string, number> = {};
  let firstSeen = group.exchanges[0]?.recordedAt ?? "";
  let lastSeen = firstSeen;
  for (const exchange of group.exchanges) {
    const status = String(exchange.response.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (exchange.recordedAt < firstSeen) firstSeen = exchange.recordedAt;
    if (exchange.recordedAt > lastSeen) lastSeen = exchange.recordedAt;
  }

  const parameters = [
    ...pathParameters(group, model),
    ...queryParameters(group),
  ];
  parameters.sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name));

  const operation: OpenApiOperation = {
    operationId: operationId(group.method, group.template),
    summary: `${group.method} ${group.template}`,
    description: `Inferred from ${samples} exchange(s).`,
    responses: buildResponses(group),
    "x-atm": { samples, statuses, firstSeen, lastSeen },
  };
  if (parameters.length > 0) operation.parameters = parameters;
  const requestBody = buildRequestBody(group);
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

function operationId(method: string, template: string): string {
  const parts = template
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.startsWith("{") && part.endsWith("}")) return pascal(part.slice(1, -1));
      return pascal(part);
    });
  const suffix = parts.map((part) => pascal(part)).join("");
  return `${method.toLowerCase()}${suffix}`;
}

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function pathParameters(group: Group, model: PathModel): OpenApiParameter[] {
  const compiled = model.templates.find((template) => template.template === group.template);
  if (!compiled || compiled.paramNames.length === 0) return [];
  const values = new Map<string, string[]>();
  for (const name of compiled.paramNames) values.set(name, []);
  for (const exchange of group.exchanges) {
    const resolved = model.resolve(exchange.request.path);
    if (resolved.template !== group.template) continue;
    for (const name of compiled.paramNames) {
      const raw = resolved.params[name];
      if (raw !== undefined) values.get(name)?.push(raw);
    }
  }
  return compiled.paramNames.map((name) => {
    const raws = values.get(name) ?? [];
    const schema = inferSchema(raws.map((raw) => coerceScalar(raw)));
    const parameter: OpenApiParameter = {
      name,
      in: "path",
      required: true,
      description: "Inferred path parameter.",
      schema,
    };
    if (raws[0] !== undefined) parameter.example = coerceScalar(raws[0]);
    return parameter;
  });
}

function queryParameters(group: Group): OpenApiParameter[] {
  const keys = new Set<string>();
  for (const exchange of group.exchanges) {
    for (const key of Object.keys(exchange.request.query)) keys.add(key);
  }
  const total = group.exchanges.length;
  return [...keys].sort().map((name) => {
    const raws: string[] = [];
    let present = 0;
    let multi = false;
    for (const exchange of group.exchanges) {
      const value = exchange.request.query[name];
      if (value === undefined) continue;
      present += 1;
      if (Array.isArray(value)) {
        multi = true;
        raws.push(...value);
      } else raws.push(value);
    }
    let schema = inferSchema(raws.map((raw) => coerceScalar(raw)));
    if (multi) schema = { type: "array", items: schema };
    const parameter: OpenApiParameter = {
      name,
      in: "query",
      required: present === total && total > 0,
      description: "Inferred query parameter.",
      schema,
    };
    if (raws[0] !== undefined) parameter.example = coerceScalar(raws[0]);
    return parameter;
  });
}

function buildRequestBody(group: Group): OpenApiOperation["requestBody"] | undefined {
  const usable = group.exchanges.filter((exchange) => !exchange.truncated && exchange.request.bodyEncoding !== "empty");
  if (usable.length === 0) return undefined;
  const byType = new Map<string, Exchange[]>();
  for (const exchange of usable) {
    const key = contentTypeFor(exchange.request.contentType, exchange.request.headers["content-type"], exchange.request.bodyEncoding);
    const bucket = byType.get(key);
    if (bucket) bucket.push(exchange);
    else byType.set(key, [exchange]);
  }
  const content: NonNullable<OpenApiOperation["requestBody"]>["content"] = {};
  for (const [type, bucket] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    content[type] = mediaFor(bucket.map((exchange) => exchange.request.body), bucket[0]?.request.bodyEncoding ?? "json");
  }
  const required = usable.length === group.exchanges.length;
  return {
    required,
    description: "Inferred request body.",
    content,
  };
}

function buildResponses(group: Group): OpenApiOperation["responses"] {
  const byStatus = new Map<number, Exchange[]>();
  for (const exchange of group.exchanges) {
    const bucket = byStatus.get(exchange.response.status);
    if (bucket) bucket.push(exchange);
    else byStatus.set(exchange.response.status, [exchange]);
  }
  const responses: OpenApiOperation["responses"] = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const bucket = byStatus.get(status) ?? [];
    const withBody = bucket.filter((exchange) => !exchange.truncated && exchange.response.bodyEncoding !== "empty");
    const response: OpenApiOperation["responses"][string] = {
      description: `Inferred from ${bucket.length} response(s) with status ${status}.`,
    };
    if (withBody.length > 0) {
      const byType = new Map<string, Exchange[]>();
      for (const exchange of withBody) {
        const key = contentTypeFor(
          exchange.response.contentType,
          exchange.response.headers["content-type"],
          exchange.response.bodyEncoding,
        );
        const typeBucket = byType.get(key);
        if (typeBucket) typeBucket.push(exchange);
        else byType.set(key, [exchange]);
      }
      response.content = {};
      for (const [type, typeBucket] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        response.content[type] = mediaFor(
          typeBucket.map((exchange) => exchange.response.body),
          typeBucket[0]?.response.bodyEncoding ?? "json",
        );
      }
    }
    responses[String(status)] = response;
  }
  return responses;
}

function contentTypeFor(
  explicit: string | undefined,
  header: string | undefined,
  encoding: Exchange["request"]["bodyEncoding"],
): string {
  const media = mediaType(explicit || header);
  if (media) return media;
  if (encoding === "json") return "application/json";
  if (encoding === "form") return "application/x-www-form-urlencoded";
  if (encoding === "text") return "text/plain";
  if (encoding === "bytes") return "application/octet-stream";
  return "application/octet-stream";
}

function mediaFor(bodies: unknown[], encoding: Exchange["request"]["bodyEncoding"]): { schema: JsonSchema; example?: unknown } {
  if (encoding === "bytes") {
    return {
      schema: {
        type: "string",
        contentEncoding: "base64",
        description: "Binary payload captured as base64. Binary bodies are not redacted.",
      },
    };
  }
  const schema = inferSchema(bodies);
  const example = trimExample(bodies[0]);
  return example === undefined ? { schema } : { schema, example };
}

function trimExample(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => trimExample(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, 20)) {
      out[key] = trimExample((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return value;
}

export interface InferFromStoreOptions {
  title?: string;
  /** Use every exchange in the store. Does not move the incremental watermark. */
  all?: boolean;
  /** Restrict to these session ids. Does not move the incremental watermark. */
  sessionIds?: string[];
  /** Write a version even when the contract hash matches the previous one. */
  force?: boolean;
}

export interface InferFromStoreResult {
  version: VersionInfo;
  spec: OpenApiDocument;
  unchanged: boolean;
  empty: boolean;
  windowSize: number;
}

export async function inferFromStore(
  store: RecordingStore,
  options: InferFromStoreOptions = {},
): Promise<InferFromStoreResult> {
  const meta = await store.getMeta();
  const sessionIds = options.sessionIds?.filter((id) => id.length > 0);
  const source: VersionInfo["source"] = sessionIds && sessionIds.length > 0 ? "session" : options.all ? "all" : "incremental";
  let exchanges = await store.listExchanges(sessionIds && sessionIds.length > 0 ? { sessionIds } : undefined);
  if (source === "incremental") {
    exchanges = exchanges.filter((exchange) => (exchange.seq ?? 0) > meta.inferredThroughSeq);
  }
  if (exchanges.length === 0) {
    const versions = await store.listVersions();
    const latest = versions[versions.length - 1];
    if (latest && source === "incremental") {
      const spec = await store.loadSpec(latest.id);
      return { version: latest, spec, unchanged: true, empty: true, windowSize: 0 };
    }
    throw new UsageError(
      source === "incremental"
        ? "No exchanges to infer. Record traffic first."
        : "No exchanges matched the requested window.",
    );
  }
  const fromSeq = exchanges[0]?.seq ?? 0;
  const throughSeq = exchanges[exchanges.length - 1]?.seq ?? fromSeq;
  const title = options.title ?? "Inferred API";
  const draft = inferOpenApi(exchanges, { title });
  const committed = await store.commitSpec({
    spec: draft,
    title,
    exchangeCount: exchanges.length,
    sessionIds: exchanges.map((exchange) => exchange.sessionId),
    fromSeq,
    throughSeq,
    source,
    force: options.force,
    advanceWatermark: source === "incremental",
  });
  return {
    version: committed.version,
    spec: committed.spec,
    unchanged: committed.unchanged,
    empty: false,
    windowSize: exchanges.length,
  };
}

export function primaryJsonSchema(content: Record<string, { schema?: JsonSchema }> | undefined): JsonSchema | undefined {
  if (!content) return undefined;
  const jsonKey = Object.keys(content).find((key) => isJsonMedia(mediaType(key)));
  const key = jsonKey ?? Object.keys(content).sort()[0];
  if (!key) return undefined;
  return content[key]?.schema;
}
