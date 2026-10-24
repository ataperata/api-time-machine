import { diffOpenApi, responseSchemaOf } from "../diff.js";
import { primaryJsonSchema } from "../infer.js";
import type { RecordingStore } from "../store.js";
import type { Change, JsonSchema, OpenApiDocument, OpenApiOperation, VersionInfo } from "../types.js";
import { typeLabel } from "../schema.js";

export interface Overview {
  root: string;
  exchanges: number;
  sessions: number;
  inferredThroughSeq: number;
  nextSeq: number;
  versions: VersionInfo[];
  latest: VersionInfo | null;
}

export interface OperationSummary {
  method: string;
  path: string;
  operationId: string;
  samples: number;
  statuses: string[];
  query: Array<{ name: string; required: boolean; types: string }>;
  requestFields: string;
  responseStatus?: string;
  responseFields: string;
}

export interface FieldInfo {
  pointer: string;
  types: string;
  required: boolean;
}

export interface TimelinePoint {
  versionId: string;
  createdAt: string;
  present: boolean;
  samples: number;
  statuses: string[];
  requestFields: FieldInfo[];
  responseFields: FieldInfo[];
  responseStatus?: string;
  changes: Change[];
}

export async function buildOverview(store: RecordingStore): Promise<Overview> {
  const [exchanges, sessions, versions, meta] = await Promise.all([
    store.listExchanges(),
    store.listSessions(),
    store.listVersions(),
    store.getMeta(),
  ]);
  return {
    root: store.root,
    exchanges: exchanges.length,
    sessions: sessions.length,
    inferredThroughSeq: meta.inferredThroughSeq,
    nextSeq: meta.nextSeq,
    versions,
    latest: versions[versions.length - 1] ?? null,
  };
}

export async function loadVersionSpecs(
  store: RecordingStore,
): Promise<Array<{ info: VersionInfo; spec: OpenApiDocument }>> {
  const versions = await store.listVersions();
  const loaded = [];
  for (const info of versions) {
    loaded.push({ info, spec: await store.loadSpec(info.id) });
  }
  return loaded;
}

export function summarizeOperations(spec: OpenApiDocument): OperationSummary[] {
  const rows: OperationSummary[] = [];
  for (const path of Object.keys(spec.paths).sort()) {
    const item = spec.paths[path] ?? {};
    for (const method of Object.keys(item)) {
      const operation = item[method];
      if (!operation) continue;
      const response = responseSchemaOf(operation);
      rows.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId ?? `${method}${path}`,
        samples: operation["x-atm"]?.samples ?? 0,
        statuses: Object.keys(operation.responses).sort((a, b) => Number(a) - Number(b)),
        query: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => ({
            name: parameter.name,
            required: parameter.required,
            types: typeLabel(parameter.schema),
          })),
        requestFields: fieldBrief(primaryJsonSchema(operation.requestBody?.content)),
        ...(response.status ? { responseStatus: response.status } : {}),
        responseFields: fieldBrief(response.schema),
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function operationMap(spec: OpenApiDocument): Map<string, { method: string; path: string; operation: OpenApiOperation }> {
  const map = new Map<string, { method: string; path: string; operation: OpenApiOperation }>();
  for (const path of Object.keys(spec.paths)) {
    const item = spec.paths[path] ?? {};
    for (const method of Object.keys(item)) {
      const operation = item[method];
      if (!operation) continue;
      map.set(`${method.toUpperCase()} ${path}`, { method: method.toUpperCase(), path, operation });
    }
  }
  return map;
}

export async function listOperationKeys(
  store: RecordingStore,
): Promise<Array<{ method: string; path: string; versionIds: string[] }>> {
  const specs = await loadVersionSpecs(store);
  const map = new Map<string, { method: string; path: string; versionIds: string[] }>();
  for (const { info, spec } of specs) {
    for (const [key, value] of operationMap(spec)) {
      const current = map.get(key);
      if (current) current.versionIds.push(info.id);
      else map.set(key, { method: value.method, path: value.path, versionIds: [info.id] });
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export async function buildTimeline(store: RecordingStore, method: string, path: string): Promise<TimelinePoint[]> {
  const specs = await loadVersionSpecs(store);
  const key = `${method.toUpperCase()} ${path}`;
  const points: TimelinePoint[] = [];
  let previous: OpenApiDocument | undefined;
  for (const { info, spec } of specs) {
    const found = operationMap(spec).get(key);
    const response = responseSchemaOf(found?.operation);
    const requestSchema = primaryJsonSchema(found?.operation.requestBody?.content);
    let changes: Change[] = [];
    if (previous) {
      changes = diffOpenApi(previous, spec, { from: "prev", to: info.id }).changes.filter((item) => item.operation === key);
    } else if (found) {
      changes = [
        {
          level: "info",
          kind: "endpoint.added",
          operation: key,
          pointer: "",
          message: `first observed in ${info.id}`,
        },
      ];
    }
    points.push({
      versionId: info.id,
      createdAt: info.createdAt,
      present: Boolean(found),
      samples: found?.operation["x-atm"]?.samples ?? 0,
      statuses: found ? Object.keys(found.operation.responses).sort((a, b) => Number(a) - Number(b)) : [],
      requestFields: flattenFields(requestSchema, "request"),
      responseFields: flattenFields(response.schema, response.status ? `response.${response.status}` : "response"),
      ...(response.status ? { responseStatus: response.status } : {}),
      changes,
    });
    previous = spec;
  }
  return points;
}

export function flattenFields(schema: JsonSchema | undefined, prefix: string, depth = 0): FieldInfo[] {
  if (!schema || depth > 3) return [];
  const fields: FieldInfo[] = [];
  const required = new Set(schema.required ?? []);
  if (schema.properties) {
    for (const key of Object.keys(schema.properties).sort()) {
      const child = schema.properties[key];
      if (!child) continue;
      const pointer = childPointer(prefix, key);
      fields.push({ pointer, types: typeLabel(child), required: required.has(key) });
      if (child.properties || child.items) fields.push(...flattenFields(child, pointer, depth + 1));
    }
  }
  if (schema.items) {
    const pointer = `${prefix}[]`;
    fields.push({ pointer, types: typeLabel(schema.items), required: false });
    fields.push(...flattenFields(schema.items, pointer, depth + 1));
  }
  return fields;
}

function childPointer(pointer: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${pointer}.${key}`;
  return `${pointer}[${JSON.stringify(key)}]`;
}

function fieldBrief(schema: JsonSchema | undefined): string {
  if (!schema) return "";
  if (!schema.properties) return typeLabel(schema);
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties)
    .sort()
    .map((key) => (required.has(key) ? key : `${key}?`))
    .join(", ");
}

export function findOperation(
  spec: OpenApiDocument,
  method: string,
  path: string,
): OpenApiOperation | undefined {
  const item = spec.paths[path];
  if (!item) return undefined;
  return item[method.toLowerCase()];
}
