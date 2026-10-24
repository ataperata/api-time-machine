import { describe, expect, it } from "vitest";
import { coerceScalar, inferSchema } from "../src/schema.js";

describe("schema inference", () => {
  it("marks fields required only when they appear in every object sample", () => {
    const schema = inferSchema([
      { id: 1, title: "A", subtitle: "x" },
      { id: 2, title: "B" },
    ]);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["id", "title"]);
    expect(schema.properties?.subtitle?.type).toBe("string");
    expect(schema.additionalProperties).toBe(true);
  });

  it("unions incompatible types, nullable fields, and nested arrays", () => {
    const schema = inferSchema([
      { a: 1, tags: ["one"] },
      { a: "x", tags: [] },
      { a: null, tags: ["two", "three"] },
    ]);
    expect(schema.properties?.a?.type).toEqual(["integer", "null", "string"]);
    expect(schema.properties?.tags?.type).toBe("array");
    expect(schema.properties?.tags?.items?.type).toBe("string");
  });

  it("collapses integer and number to number and detects formats", () => {
    expect(inferSchema([1, 1.5]).type).toBe("number");
    expect(inferSchema([1, 2, 3]).type).toBe("integer");
    const dated = inferSchema(["2026-10-23T23:32:11Z", "2026-01-02T03:04:05Z"]);
    expect(dated).toMatchObject({ type: "string", format: "date-time" });
    const uuid = inferSchema(["550e8400-e29b-41d4-a716-446655440000"]);
    expect(uuid.format).toBe("uuid");
  });

  it("infers a closed string enum only when samples repeat a small token set", () => {
    const values = ["open", "closed", "open", "closed", "open", "pending", "open", "closed", "pending"];
    expect(inferSchema(values).enum).toEqual(["closed", "open", "pending"]);
    const titles = Array.from({ length: 8 }, (_, index) => `Title ${index}`);
    expect(inferSchema(titles).enum).toBeUndefined();
  });

  it("coerces query scalars without eating leading zeroes", () => {
    expect(coerceScalar("true")).toBe(true);
    expect(coerceScalar("10")).toBe(10);
    expect(coerceScalar("1.5")).toBe(1.5);
    expect(coerceScalar("01")).toBe("01");
    expect(coerceScalar("1.50")).toBe("1.50");
    expect(inferSchema(["2", "4"].map((value) => coerceScalar(value))).type).toBe("integer");
  });
});
