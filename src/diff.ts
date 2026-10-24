import type { Change, ChangeLevel, DiffReport, JsonSchema, OpenApiDocument, OpenApiOperation } from "./types.js";
import { primaryJsonSchema } from "./infer.js";

/**
 * Classify contract changes from the perspective of an existing client.
 *
 * Response widening (new types, new enum values) and removed routes or success
 * statuses are breaking. Request narrowing (new required fields, fewer accepted
 * types, removed request enum values) is breaking. Additive optional request
 * surface and new routes are informational.
 */

interface NormSchema {
  types: string[];
  format?: string;
  enumValues?: string[];
  properties?: Record<string, NormSchema>;
  required: string[];
  items?: NormSchema;
}

interface NormBody {
  required: boolean;
  contents: Record<string, NormSchema>;
}

interface NormOp {
  pathParams: Record<string, NormSchema>;
  query: Record<string, { required: boolean; schema: NormSchema }>;
  request?: NormBody;
  responses: Record<string, NormBody>;
}

type NormDoc = Map<string, NormOp>;

const LEVEL_RANK: Record<ChangeLevel, number> = { breaking: 0, warning: 1, info: 2 };

export function diffOpenApi(
  before: OpenApiDocument,
  after: OpenApiDocument,
  labels?: { from?: string; to?: string },
): DiffReport {
  const changes: Change[] = [];
  const left = normalizeDoc(before);
  const right = normalizeDoc(after);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    if (a && !b) {
      changes.push(change("breaking", "endpoint.removed", key, "", `removed ${key}`));
      continue;
    }
    if (!a && b) {
      changes.push(change("info", "endpoint.added", key, "", `added ${key}`));
      continue;
    }
    if (a && b) diffOperation(key, a, b, changes);
  }
  changes.sort(compareChanges);
  return {
    from: { id: labels?.from ?? before.info.version },
    to: { id: labels?.to ?? after.info.version },
    changes,
    summary: summarize(changes),
  };
}

export function summarize(changes: Change[]): DiffReport["summary"] {
  return {
    breaking: changes.filter((item) => item.level === "breaking").length,
    warning: changes.filter((item) => item.level === "warning").length,
    info: changes.filter((item) => item.level === "info").length,
  };
}

export function formatDiffReport(report: DiffReport, color = false): string {
  const paint = (code: string, text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const lines: string[] = [];
  lines.push(`diff ${report.from.id} → ${report.to.id}`);
  const groups: Array<{ level: ChangeLevel; label: string; code: string }> = [
    { level: "breaking", label: "BREAKING", code: "31" },
    { level: "warning", label: "WARNING", code: "33" },
    { level: "info", label: "INFO", code: "36" },
  ];
  if (report.changes.length === 0) {
    lines.push("No contract changes.");
  }
  for (const group of groups) {
    const items = report.changes.filter((item) => item.level === group.level);
    if (items.length === 0) continue;
    lines.push("");
    lines.push(paint(group.code, `${group.label} (${items.length})`));
    for (const item of items) {
      const where = item.pointer ? `${item.operation} ${item.pointer}` : item.operation;
      lines.push(`  ${item.kind}  ${where}`);
      lines.push(`    ${item.message}`);
    }
  }
  lines.push("");
  lines.push(
    `${report.summary.breaking} breaking, ${report.summary.warning} warning, ${report.summary.info} info`,
  );
  return lines.join("\n");
}

function change(level: ChangeLevel, kind: string, operation: string, pointer: string, message: string): Change {
  return { level, kind, operation, pointer, message };
}

function compareChanges(a: Change, b: Change): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    a.operation.localeCompare(b.operation) ||
    a.kind.localeCompare(b.kind) ||
    a.pointer.localeCompare(b.pointer) ||
    a.message.localeCompare(b.message)
  );
}

function normalizeDoc(doc: OpenApiDocument): NormDoc {
  const map: NormDoc = new Map();
  for (const path of Object.keys(doc.paths).sort()) {
    const item = doc.paths[path] ?? {};
    for (const method of Object.keys(item).sort()) {
      const operation = item[method];
      if (!operation) continue;
      map.set(`${method.toUpperCase()} ${path}`, normalizeOperation(operation));
    }
  }
  return map;
}

function normalizeOperation(operation: OpenApiOperation): NormOp {
  const pathParams: Record<string, NormSchema> = {};
  const query: NormOp["query"] = {};
  for (const parameter of operation.parameters ?? []) {
    const schema = normalizeSchema(parameter.schema);
    if (parameter.in === "path") pathParams[parameter.name] = schema;
    if (parameter.in === "query") query[parameter.name] = { required: parameter.required, schema };
  }
  const op: NormOp = { pathParams, query, responses: {} };
  if (operation.requestBody) {
    op.request = {
      required: operation.requestBody.required ?? false,
      contents: normalizeContent(operation.requestBody.content),
    };
  }
  for (const status of Object.keys(operation.responses).sort()) {
    const response = operation.responses[status];
    if (!response) continue;
    op.responses[status] = {
      required: true,
      contents: normalizeContent(response.content),
    };
  }
  return op;
}

function normalizeContent(content: Record<string, { schema?: JsonSchema }> | undefined): Record<string, NormSchema> {
  const out: Record<string, NormSchema> = {};
  if (!content) return out;
  for (const key of Object.keys(content).sort()) {
    const schema = content[key]?.schema;
    if (schema) out[key] = normalizeSchema(schema);
  }
  return out;
}

function normalizeSchema(schema: JsonSchema | undefined): NormSchema {
  if (!schema) return { types: [], required: [] };
  let types: string[] = [];
  if (Array.isArray(schema.type)) types = [...new Set(schema.type)];
  else if (typeof schema.type === "string") types = [schema.type];
  else if (schema.properties) types = ["object"];
  else if (schema.items) types = ["array"];
  if (types.includes("number")) types = types.filter((type) => type !== "integer");
  types.sort();
  const norm: NormSchema = { types, required: [...(schema.required ?? [])].sort() };
  if (schema.format) norm.format = schema.format;
  if (schema.enum) {
    norm.enumValues = schema.enum.map((item) => JSON.stringify(item)).sort();
  }
  if (schema.properties) {
    const properties: Record<string, NormSchema> = {};
    for (const key of Object.keys(schema.properties).sort()) {
      const child = schema.properties[key];
      if (child) properties[key] = normalizeSchema(child);
    }
    norm.properties = properties;
  }
  if (schema.items) norm.items = normalizeSchema(schema.items);
  return norm;
}

function diffOperation(operation: string, before: NormOp, after: NormOp, changes: Change[]): void {
  const pathNames = [...new Set([...Object.keys(before.pathParams), ...Object.keys(after.pathParams)])].sort();
  for (const name of pathNames) {
    const left = before.pathParams[name];
    const right = after.pathParams[name];
    if (left && !right) {
      changes.push(change("breaking", "path.param.removed", operation, `path.${name}`, `removed path parameter ${name}`));
    } else if (!left && right) {
      changes.push(change("breaking", "path.param.added", operation, `path.${name}`, `added path parameter ${name}`));
    } else if (left && right) {
      diffSchema(left, right, "request", operation, `path.${name}`, changes);
    }
  }

  const queryNames = [...new Set([...Object.keys(before.query), ...Object.keys(after.query)])].sort();
  for (const name of queryNames) {
    const left = before.query[name];
    const right = after.query[name];
    const pointer = `query.${name}`;
    if (left && !right) {
      changes.push(
        change(
          left.required ? "warning" : "info",
          "query.removed",
          operation,
          pointer,
          `removed ${left.required ? "required " : ""}query parameter ${name}`,
        ),
      );
    } else if (!left && right) {
      changes.push(
        change(
          right.required ? "breaking" : "info",
          "query.added",
          operation,
          pointer,
          `added ${right.required ? "required " : "optional "}query parameter ${name}`,
        ),
      );
    } else if (left && right) {
      if (!left.required && right.required) {
        changes.push(change("breaking", "query.now_required", operation, pointer, `query parameter ${name} is now required`));
      } else if (left.required && !right.required) {
        changes.push(change("info", "query.now_optional", operation, pointer, `query parameter ${name} is now optional`));
      }
      diffSchema(left.schema, right.schema, "request", operation, pointer, changes);
    }
  }

  diffBody(operation, "request", before.request, after.request, changes);
  diffResponses(operation, before.responses, after.responses, changes);
}

function diffResponses(
  operation: string,
  before: Record<string, NormBody>,
  after: Record<string, NormBody>,
  changes: Change[],
): void {
  const statuses = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => Number(a) - Number(b));
  for (const status of statuses) {
    const left = before[status];
    const right = after[status];
    const pointer = `response.${status}`;
    if (left && !right) {
      const level: ChangeLevel = isSuccess(status) ? "breaking" : "warning";
      changes.push(change(level, "response.status.removed", operation, pointer, `removed response status ${status}`));
    } else if (!left && right) {
      changes.push(change("info", "response.status.added", operation, pointer, `added response status ${status}`));
    } else if (left && right) {
      diffContent(operation, "response", pointer, left.contents, right.contents, changes);
    }
  }
}

function diffBody(
  operation: string,
  side: "request" | "response",
  before: NormBody | undefined,
  after: NormBody | undefined,
  changes: Change[],
): void {
  if (!before && !after) return;
  if (before && !after) {
    const level: ChangeLevel = side === "response" ? "breaking" : "info";
    changes.push(change(level, `${side}.body.removed`, operation, side, `removed ${side} body`));
    return;
  }
  if (!before && after) {
    const level: ChangeLevel = side === "request" && after.required ? "breaking" : "info";
    changes.push(
      change(level, `${side}.body.added`, operation, side, `added ${after.required ? "required " : ""}${side} body`),
    );
    return;
  }
  if (!before || !after) return;
  if (side === "request" && !before.required && after.required) {
    changes.push(change("breaking", "request.body.now_required", operation, "request", "request body is now required"));
  } else if (side === "request" && before.required && !after.required) {
    changes.push(change("info", "request.body.now_optional", operation, "request", "request body is now optional"));
  }
  diffContent(operation, side, side, before.contents, after.contents, changes);
}

function diffContent(
  operation: string,
  side: "request" | "response",
  pointer: string,
  before: Record<string, NormSchema>,
  after: Record<string, NormSchema>,
  changes: Change[],
): void {
  const types = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const type of types) {
    const left = before[type];
    const right = after[type];
    const where = `${pointer}.${type}`;
    if (left && !right) {
      const level: ChangeLevel = "breaking";
      changes.push(change(level, `${side}.content.removed`, operation, where, `removed ${side} content type ${type}`));
    } else if (!left && right) {
      changes.push(change("info", `${side}.content.added`, operation, where, `added ${side} content type ${type}`));
    } else if (left && right) {
      diffSchema(left, right, side, operation, where, changes);
    }
  }
}

function diffSchema(
  before: NormSchema,
  after: NormSchema,
  side: "request" | "response",
  operation: string,
  pointer: string,
  changes: Change[],
): void {
  diffTypes(before, after, side, operation, pointer, changes);
  diffEnum(before, after, side, operation, pointer, changes);
  if (before.format !== after.format && (before.format || after.format)) {
    changes.push(
      change(
        "warning",
        "schema.format.changed",
        operation,
        pointer,
        `format changed from ${before.format ?? "(none)"} to ${after.format ?? "(none)"}`,
      ),
    );
  }
  if (isObject(before) && isObject(after)) diffProperties(before, after, side, operation, pointer, changes);
  if (isArray(before) && isArray(after) && before.items && after.items) {
    diffSchema(before.items, after.items, side, operation, `${pointer}[]`, changes);
  }
}

function isObject(schema: NormSchema): boolean {
  return schema.types.includes("object") || schema.properties !== undefined;
}

function isArray(schema: NormSchema): boolean {
  return schema.types.includes("array") || schema.items !== undefined;
}

function diffTypes(
  before: NormSchema,
  after: NormSchema,
  side: "request" | "response",
  operation: string,
  pointer: string,
  changes: Change[],
): void {
  const left = new Set(before.types);
  const right = new Set(after.types);
  if (sameTypes(left, right)) return;

  if (left.size === 1 && right.size === 1) {
    const from = [...left][0] ?? "any";
    const to = [...right][0] ?? "any";
    const numericChange =
      (from === "integer" || from === "number") && (to === "integer" || to === "number");
    if (numericChange) {
      const widened = from === "integer" && to === "number";
      const level: ChangeLevel = side === "request" && !widened ? "breaking" : "warning";
      changes.push(
        change(
          level,
          side === "request" ? (widened ? "request.type.widened" : "request.type.narrowed") : "response.type.changed",
          operation,
          pointer,
          `numeric type changed from ${from} to ${to}`,
        ),
      );
      return;
    }
    changes.push(
      change("breaking", `${side}.type.changed`, operation, pointer, `${side} type changed from ${from} to ${to}`),
    );
    return;
  }

  for (const type of [...left].sort()) {
    if (right.has(type)) continue;
    const level: ChangeLevel = side === "request" ? "breaking" : "warning";
    changes.push(
      change(
        level,
        side === "request" ? "request.type.narrowed" : "response.type.narrowed",
        operation,
        pointer,
        `${side} no longer ${type === "null" ? "nullable" : `typed ${type}`}`,
      ),
    );
  }
  for (const type of [...right].sort()) {
    if (left.has(type)) continue;
    const level: ChangeLevel = side === "response" ? "breaking" : "info";
    changes.push(
      change(
        level,
        side === "response" ? "response.type.widened" : "request.type.widened",
        operation,
        pointer,
        `${side} ${type === "null" ? "became nullable" : `accepted type added: ${type}`}`,
      ),
    );
  }
}

function sameTypes(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const type of left) if (!right.has(type)) return false;
  return true;
}

function diffEnum(
  before: NormSchema,
  after: NormSchema,
  side: "request" | "response",
  operation: string,
  pointer: string,
  changes: Change[],
): void {
  if (!before.enumValues && !after.enumValues) return;
  if (!before.enumValues && after.enumValues) {
    const level: ChangeLevel = side === "request" ? "breaking" : "warning";
    changes.push(change(level, "schema.enum.added", operation, pointer, "enum constraint added"));
    return;
  }
  if (before.enumValues && !after.enumValues) {
    const level: ChangeLevel = side === "request" ? "info" : "warning";
    changes.push(change(level, "schema.enum.removed", operation, pointer, "enum constraint removed"));
    return;
  }
  const left = new Set(before.enumValues);
  const right = new Set(after.enumValues);
  for (const value of [...left].sort()) {
    if (right.has(value)) continue;
    if (side === "request") {
      changes.push(change("breaking", "request.enum.removed", operation, pointer, `request enum value removed: ${value}`));
    } else {
      changes.push(change("warning", "response.enum.removed", operation, pointer, `response enum value removed: ${value}`));
    }
  }
  for (const value of [...right].sort()) {
    if (left.has(value)) continue;
    if (side === "response") {
      changes.push(change("breaking", "response.enum.added", operation, pointer, `response enum value added: ${value}`));
    } else {
      changes.push(change("info", "request.enum.added", operation, pointer, `request enum value added: ${value}`));
    }
  }
}

function diffProperties(
  before: NormSchema,
  after: NormSchema,
  side: "request" | "response",
  operation: string,
  pointer: string,
  changes: Change[],
): void {
  const leftProps = before.properties ?? {};
  const rightProps = after.properties ?? {};
  const leftReq = new Set(before.required);
  const rightReq = new Set(after.required);
  const keys = [...new Set([...Object.keys(leftProps), ...Object.keys(rightProps)])].sort();
  for (const key of keys) {
    const left = leftProps[key];
    const right = rightProps[key];
    const where = childPointer(pointer, key);
    if (left && !right) {
      if (side === "response") {
        const level: ChangeLevel = leftReq.has(key) ? "breaking" : "warning";
        changes.push(
          change(level, "response.field.removed", operation, where, `removed ${leftReq.has(key) ? "required " : "optional "}response field ${where}`),
        );
      } else {
        changes.push(change("info", "request.field.removed", operation, where, `removed request field ${where}`));
      }
      continue;
    }
    if (!left && right) {
      if (side === "request") {
        const level: ChangeLevel = rightReq.has(key) ? "breaking" : "info";
        changes.push(
          change(
            level,
            "request.field.added",
            operation,
            where,
            `added ${rightReq.has(key) ? "required " : "optional "}request field ${where}`,
          ),
        );
      } else {
        changes.push(change("info", "response.field.added", operation, where, `added response field ${where}`));
      }
      continue;
    }
    if (!left || !right) continue;
    if (side === "request") {
      if (!leftReq.has(key) && rightReq.has(key)) {
        changes.push(change("breaking", "request.field.now_required", operation, where, `request field ${where} is now required`));
      } else if (leftReq.has(key) && !rightReq.has(key)) {
        changes.push(change("info", "request.field.now_optional", operation, where, `request field ${where} is now optional`));
      }
    } else if (leftReq.has(key) && !rightReq.has(key)) {
      changes.push(change("warning", "response.field.now_optional", operation, where, `response field ${where} is now optional`));
    } else if (!leftReq.has(key) && rightReq.has(key)) {
      changes.push(change("info", "response.field.now_required", operation, where, `response field ${where} is now required`));
    }
    diffSchema(left, right, side, operation, where, changes);
  }
}

function childPointer(pointer: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${pointer}.${key}`;
  return `${pointer}[${JSON.stringify(key)}]`;
}

function isSuccess(status: string): boolean {
  const code = Number(status);
  return code >= 200 && code < 400;
}

export function responseSchemaOf(operation: OpenApiOperation | undefined): { status?: string; schema?: JsonSchema } {
  if (!operation) return {};
  const statuses = Object.keys(operation.responses).sort((a, b) => Number(a) - Number(b));
  const success = statuses.find((status) => Number(status) >= 200 && Number(status) < 300) ?? statuses[0];
  if (!success) return {};
  const response = operation.responses[success];
  return { status: success, schema: primaryJsonSchema(response?.content) };
}
