import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffOpenApi } from "../src/diff.js";
import { inferOpenApi } from "../src/infer.js";
import { specHash } from "../src/store.js";
import { catalogV1, catalogV2, exchange } from "./helpers.js";

describe("openapi inference and breaking changes", () => {
  it("infers paths, params, and merged schemas from the catalog fixture", () => {
    const spec = inferOpenApi(catalogV1(), { title: "Catalog" });
    expect(spec.openapi).toBe("3.1.0");
    const getBook = spec.paths["/books/{bookId}"]?.get;
    expect(getBook?.operationId).toBe("getBooksBookId");
    const bookId = getBook?.parameters?.find((parameter) => parameter.name === "bookId");
    expect(bookId).toMatchObject({ in: "path", required: true, schema: { type: "integer" } });
    const list = spec.paths["/books"]?.get;
    const limit = list?.parameters?.find((parameter) => parameter.name === "limit");
    expect(limit).toMatchObject({ in: "query", required: true });
    expect(list?.responses["200"]?.content?.["application/json"]?.schema?.properties?.books?.items?.required).toEqual([
      "author",
      "id",
      "inStock",
      "price",
      "title",
    ]);
    const create = spec.paths["/books"]?.post;
    expect(create?.requestBody?.required).toBe(true);
    expect(create?.requestBody?.content["application/json"]?.schema?.required).toEqual(["author", "price", "title"]);
    expect(spec.paths["/authors/{authorId}"]?.get).toBeTruthy();
    expect(spec.paths["/users/me"]).toBeUndefined();
  });

  it("treats a field seen in only some samples as optional", () => {
    const spec = inferOpenApi([
      exchange({ path: "/books/1", responseBody: { id: 1, title: "A", subtitle: "x" } }),
      exchange({ path: "/books/2", responseBody: { id: 2, title: "B" } }),
    ]);
    const schema = spec.paths["/books/{bookId}"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
    expect(schema?.required).toEqual(["id", "title"]);
    expect(schema?.properties?.subtitle?.type).toBe("string");
  });

  it("hashes the contract without examples or sample counts", () => {
    const left = inferOpenApi(catalogV1());
    const right = inferOpenApi(catalogV1());
    expect(specHash(left)).toBe(specHash(right));
    const mutated = structuredClone(right);
    const media = mutated.paths["/health"]?.get?.responses["200"]?.content?.["application/json"];
    if (media) media.example = { status: "different" };
    expect(specHash(mutated)).toBe(specHash(left));
  });

  it("reports breaking, warning, and informational changes between catalog versions", () => {
    const report = diffOpenApi(inferOpenApi(catalogV1()), inferOpenApi(catalogV2()), {
      from: "v1",
      to: "v2",
    });
    const breaking = report.changes.filter((change) => change.level === "breaking").map((change) => change.kind);
    expect(breaking).toEqual(
      expect.arrayContaining([
        "endpoint.removed",
        "query.added",
        "request.field.added",
        "response.type.changed",
        "response.field.removed",
      ]),
    );
    expect(report.changes.some((change) => change.kind === "endpoint.removed" && change.operation.includes("/authors/"))).toBe(true);
    expect(report.changes.some((change) => change.kind === "query.added" && change.pointer === "query.cursor")).toBe(true);
    expect(report.changes.some((change) => change.kind === "request.field.added" && change.pointer.includes("isbn"))).toBe(true);
    expect(report.changes.some((change) => change.kind === "response.type.changed" && change.pointer.includes("price"))).toBe(true);
    expect(report.changes.some((change) => change.kind === "response.field.removed" && change.pointer.includes("rating"))).toBe(true);
    expect(report.changes.some((change) => change.kind === "response.field.removed" && change.pointer.includes("inStock"))).toBe(true);
    expect(report.changes.some((change) => change.level === "info" && change.kind === "endpoint.added" && change.operation.includes("/related"))).toBe(true);
    expect(report.changes.some((change) => change.level === "info" && change.kind === "response.field.added" && change.pointer.includes("currency"))).toBe(true);
    expect(report.summary.breaking).toBeGreaterThan(0);
  });

  it("emits no changes for identical specs", () => {
    const spec = inferOpenApi(catalogV1());
    const report = diffOpenApi(spec, structuredClone(spec));
    expect(report.changes).toEqual([]);
    expect(report.summary).toEqual({ breaking: 0, warning: 0, info: 0 });
  });

  it("reads the checked-in bookstore cassette", async () => {
    const text = await readFile(join(process.cwd(), "examples/bookstore-v1.jsonl"), "utf8");
    const exchanges = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { _atm?: string })
      .filter((row) => row._atm !== "header");
    const spec = inferOpenApi(exchanges as never);
    expect(spec.paths["/books/{bookId}"]?.get).toBeTruthy();
    expect(JSON.stringify(spec)).not.toContain("super-secret");
  });
});
