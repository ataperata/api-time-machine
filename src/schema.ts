import type { JsonSchema } from "./types.js";

/**
 * Merge JSON samples into an OpenAPI 3.1 schema.
 * A property is required only when it is present on every object sample.
 * Numeric ranges are intentionally omitted: observed min/max tracks the sample
 * window, not the contract, and would churn versions as ids grow.
 */

const ENUM_RE = /^[a-z][a-z0-9_-]{0,32}$/;
const ENUM_MIN_SAMPLES = 6;
const ENUM_MAX_UNIQUE = 6;

const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const URI_RE = /^https?:\/\/\S+$/i;

export interface Accumulator {
  samples: number;
  typeCounts: Record<string, number>;
  formats: Record<string, number>;
  enumDisabled: boolean;
  enumCounts: Map<string, { value: string; count: number }>;
  stringSamples: number;
  objectSamples: number;
  properties: Record<string, { present: number; acc: Accumulator }>;
  arraySamples: number;
  items: Accumulator | null;
}

export function createAccumulator(): Accumulator {
  return {
    samples: 0,
    typeCounts: {},
    formats: {},
    enumDisabled: false,
    enumCounts: new Map(),
    stringSamples: 0,
    objectSamples: 0,
    properties: {},
    arraySamples: 0,
    items: null,
  };
}

export function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return "string";
  }
}

export function detectStringFormat(value: string): string | undefined {
  if (DATE_TIME_RE.test(value)) return "date-time";
  if (DATE_RE.test(value)) return "date";
  if (UUID_RE.test(value)) return "uuid";
  if (EMAIL_RE.test(value)) return "email";
  if (URI_RE.test(value)) return "uri";
  return undefined;
}

export function observe(acc: Accumulator, value: unknown): void {
  acc.samples += 1;
  const type = jsonType(value);
  acc.typeCounts[type] = (acc.typeCounts[type] ?? 0) + 1;

  if (typeof value === "string") {
    acc.stringSamples += 1;
    const format = detectStringFormat(value);
    if (format) acc.formats[format] = (acc.formats[format] ?? 0) + 1;
    if (!acc.enumDisabled) {
      if (acc.enumCounts.size >= 20 && !acc.enumCounts.has(value)) acc.enumDisabled = true;
      else {
        const current = acc.enumCounts.get(value);
        if (current) current.count += 1;
        else acc.enumCounts.set(value, { value, count: 1 });
      }
    }
    return;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    acc.objectSamples += 1;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      let slot = acc.properties[key];
      if (!slot) {
        slot = { present: 0, acc: createAccumulator() };
        acc.properties[key] = slot;
      }
      slot.present += 1;
      observe(slot.acc, child);
    }
    return;
  }

  if (Array.isArray(value)) {
    acc.arraySamples += 1;
    if (!acc.items) acc.items = createAccumulator();
    for (const item of value) observe(acc.items, item);
  }
}

export function observeAll(values: unknown[]): Accumulator {
  const acc = createAccumulator();
  for (const value of values) observe(acc, value);
  return acc;
}

function normalizedTypes(acc: Accumulator): string[] {
  const types = Object.keys(acc.typeCounts).filter((type) => (acc.typeCounts[type] ?? 0) > 0);
  if (types.includes("number")) return types.filter((type) => type !== "integer").sort();
  return types.sort();
}

export function finalizeSchema(acc: Accumulator): JsonSchema {
  if (acc.samples === 0) return {};
  const types = normalizedTypes(acc);
  const schema: JsonSchema = {};
  if (types.length === 1) schema.type = types[0];
  else if (types.length > 1) schema.type = types;

  if (types.length === 1 && types[0] === "string") {
    const formats = Object.entries(acc.formats);
    if (formats.length === 1) {
      const entry = formats[0];
      if (entry && entry[1] === acc.stringSamples) schema.format = entry[0];
    }
    if (!acc.enumDisabled && !schema.format && acc.stringSamples >= ENUM_MIN_SAMPLES) {
      const uniques = [...acc.enumCounts.values()];
      if (
        uniques.length >= 2 &&
        uniques.length <= ENUM_MAX_UNIQUE &&
        acc.stringSamples >= uniques.length * 3 &&
        uniques.every((item) => ENUM_RE.test(item.value))
      ) {
        schema.enum = uniques.map((item) => item.value).sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (acc.objectSamples > 0) {
    const keys = Object.keys(acc.properties).sort();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const key of keys) {
      const slot = acc.properties[key];
      if (!slot) continue;
      properties[key] = finalizeSchema(slot.acc);
      if (slot.present === acc.objectSamples) required.push(key);
    }
    schema.properties = properties;
    if (required.length > 0) schema.required = required;
    schema.additionalProperties = true;
  }

  if (acc.arraySamples > 0) {
    schema.items = acc.items && acc.items.samples > 0 ? finalizeSchema(acc.items) : {};
  }

  return schema;
}

export function inferSchema(values: unknown[]): JsonSchema {
  return finalizeSchema(observeAll(values));
}

/** Coerce query/path strings into JSON-ish scalars before schema inference. */
export function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isSafeInteger(asNumber) && String(asNumber) === raw) return asNumber;
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && String(asNumber) === raw) return asNumber;
  }
  return raw;
}

export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return "";
  if (schema.enum) return `enum[${schema.enum.map((item) => JSON.stringify(item)).join("|")}]`;
  if (!schema.type) {
    if (schema.properties) return "object";
    if (schema.items) return "array";
    return "any";
  }
  return Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
}
