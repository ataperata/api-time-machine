import { describe, expect, it } from "vitest";
import { isStrongId, learnPaths, normalizePath, singularize } from "../src/path-template.js";

function templates(paths: string[]): string[] {
  return learnPaths(paths).templates.map((template) => template.template);
}

describe("path templates", () => {
  it("normalizes trailing slashes and encoding", () => {
    expect(normalizePath("/users/1/")).toBe("/users/1");
    expect(normalizePath("/users/a%2Fb")).toBe("/users/a/b");
    expect(normalizePath("/")).toBe("/");
  });

  it("singularizes resource names", () => {
    expect(singularize("books")).toBe("book");
    expect(singularize("addresses")).toBe("address");
    expect(singularize("statuses")).toBe("status");
    expect(singularize("companies")).toBe("company");
    expect(singularize("settings")).toBe("settings");
  });

  it("keeps static routes and parameterizes identifiers", () => {
    expect(templates(["/health", "/health"])).toEqual(["/health"]);
    expect(templates(["/api/v1/health"])).toEqual(["/api/v1/health"]);
    expect(templates(["/users/1", "/users/2", "/users/3"])).toEqual(["/users/{userId}"]);
    expect(templates(["/users/550e8400-e29b-41d4-a716-446655440000"])).toEqual(["/users/{userId}"]);
    expect(templates(["/users/507f1f77bcf86cd799439011"])).toEqual(["/users/{userId}"]);
    expect(templates(["/users/me"])).toEqual(["/users/me"]);
    expect(templates(["/users/me", "/users/42"])).toEqual(["/users/me", "/users/{userId}"]);
    expect(templates(["/books/1/reviews/9", "/books/2/reviews/8"])).toEqual(["/books/{bookId}/reviews/{reviewId}"]);
    expect(templates(["/pets/dogs", "/pets/cats"])).toEqual(["/pets/cats", "/pets/dogs"]);
    expect(templates(["/v1/status", "/v2/status"])).toEqual(["/v1/status", "/v2/status"]);
    expect(templates(["/reports/2024/summary"])).toEqual(["/reports/2024/summary"]);
    expect(isStrongId("2024")).toBe(false);
    expect(isStrongId("42")).toBe(true);
  });

  it("parameterizes high-cardinality literals under a plural parent", () => {
    const orgs = ["acme", "globex", "initech", "hooli", "stark", "wayne"];
    const paths = orgs.map((org, index) => `/orgs/${org}/users/${index + 1}`);
    expect(templates(paths)).toEqual(["/orgs/{orgId}/users/{userId}"]);
    const names = ["ada", "grace", "linus", "radia", "barbara", "margaret"];
    expect(templates(names.map((name) => `/users/${name}`))).toEqual(["/users/{userId}"]);
  });

  it("resolves unseen ids to the learned template and prefers the alias route", () => {
    const model = learnPaths(["/users/me", "/users/1", "/users/2"]);
    expect(model.resolve("/users/99")).toEqual({ template: "/users/{userId}", params: { userId: "99" } });
    expect(model.resolve("/users/me").template).toBe("/users/me");
    expect(model.resolve("/health")).toEqual({ template: "/health", params: {} });
  });
});
