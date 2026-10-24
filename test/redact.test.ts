import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultRedactionConfig,
  luhn,
  redactExchange,
  redactString,
  redactValue,
  redactionFromJson,
} from "../src/redact.js";
import { exchange } from "./helpers.js";

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redaction", () => {
  it("redacts secret headers, nested keys, and PII inside strings", () => {
    const original = exchange({
      path: "/profile",
      query: { token: "abc", limit: "1" },
      requestHeaders: {
        authorization: "Bearer super-secret",
        "x-request-id": "req-1",
        cookie: "sid=nope",
      },
      requestBody: {
        name: "Ada",
        password: "hunter2",
        profile: { accessToken: "tok", note: `mail ada@example.com ssn 219-09-9999 jwt ${TOKEN}` },
        cards: [{ creditCard: "4111111111111111" }, { label: "4111111111111111" }],
      },
      responseBody: { ownerEmail: "ada@example.com", secretary: "kept" },
    });
    const redacted = redactExchange(original);
    expect(original.request.headers.authorization).toBe("Bearer super-secret");
    expect(redacted.request.headers.authorization).toBe("[REDACTED]");
    expect(redacted.request.headers.cookie).toBe("[REDACTED]");
    expect(redacted.request.headers["x-request-id"]).toBe("req-1");
    expect(redacted.request.query.token).toBe("[REDACTED]");
    expect(redacted.request.query.limit).toBe("1");
    const body = redacted.request.body as {
      password: string;
      profile: { accessToken: string; note: string };
      cards: Array<{ creditCard?: string; label?: string }>;
    };
    expect(body.password).toBe("[REDACTED]");
    expect(body.profile.accessToken).toBe("[REDACTED]");
    expect(body.profile.note).not.toContain("ada@example.com");
    expect(body.profile.note).not.toContain("219-09-9999");
    expect(body.profile.note).not.toContain(TOKEN);
    expect(body.cards[0]?.creditCard).toBe("[REDACTED]");
    expect(body.cards[1]?.label).toBe("[REDACTED]");
    expect((redacted.response.body as { secretary: string }).secretary).toBe("kept");
    expect((redacted.response.body as { ownerEmail: string }).ownerEmail).toBe("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("keeps non-Luhn digit strings and normal prose", () => {
    const config = defaultRedactionConfig();
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("1234567890123456")).toBe(false);
    const text = redactString("ticket 1234567890123456 and use your token wisely", { config, headerPatterns: [], keyPatterns: [], extraKeys: new Set(), queryKeys: new Set(), headerNames: new Set(), valuePatterns: [] });
    expect(text).toContain("1234567890123456");
    expect(text).toContain("token wisely");
  });

  it("applies a caller-supplied pattern and can disable builtins", () => {
    const config = redactionFromJson({
      builtins: false,
      replacement: "***",
      headers: ["x-internal-key"],
      jsonKeys: ["internalNotes"],
      valuePatterns: [{ name: "employee-id", pattern: "\\bEMP\\d{6}\\b" }],
    });
    const value = redactValue({ authorization: "leave-me", internalNotes: "EMP000123", employee: "EMP000123" }, {
      config,
      headerPatterns: [],
      keyPatterns: [],
      extraKeys: new Set(config.jsonKeys.map((key) => key.toLowerCase())),
      queryKeys: new Set(),
      headerNames: new Set(config.headers),
      valuePatterns: config.valuePatterns.map((pattern) => ({ name: pattern.name, regex: new RegExp(pattern.pattern, "g") })),
    });
    expect(value).toEqual({ authorization: "leave-me", internalNotes: "***", employee: "***" });
  });

  it("rejects an invalid regex in config", () => {
    expect(() => redactionFromJson({ valuePatterns: [{ name: "bad", pattern: "(" }] })).toThrow(/Invalid redaction regex/);
  });

  it("loads the example redaction file", async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), "examples/redaction.json"), "utf8"));
    const config = redactionFromJson(raw);
    expect(config.headers.map((header) => header.toLowerCase())).toContain("x-internal-key");
    expect(config.builtins).toBe(true);
  });
});
