import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { inferFromStore } from "../src/infer.js";
import { closeServer, listen } from "../src/http-util.js";
import { startRecordingProxy } from "../src/proxy.js";
import { buildUpstreamUrl } from "../src/url.js";
import { diffOpenApi } from "../src/diff.js";
import { exchange, tempStore } from "./helpers.js";

describe("upstream url", () => {
  it("pins the configured origin", () => {
    expect(buildUpstreamUrl("http://127.0.0.1:4000/v1", "/books?x=1")).toBe("http://127.0.0.1:4000/v1/books?x=1");
    const absolute = new URL(buildUpstreamUrl("http://127.0.0.1:4000/api", "http://evil.example/books?x=1"));
    expect(absolute.host).toBe("127.0.0.1:4000");
    expect(absolute.pathname).toBe("/api/books");
    const sneaky = new URL(buildUpstreamUrl("http://127.0.0.1:4000", "//evil.example/foo"));
    expect(sneaky.host).toBe("127.0.0.1:4000");
    expect(sneaky.pathname).toBe("/evil.example/foo");
  });
});

describe("recording proxy and version windows", () => {
  it("forwards live traffic and persists a redacted cassette", async () => {
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const payload = {
          path: req.url,
          authorization: req.headers.authorization ?? null,
          body: body ? JSON.parse(body) : null,
          echo: { email: "ada@example.com", status: "ok" },
        };
        const raw = JSON.stringify(payload);
        res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
        res.end(raw);
      });
    });
    const upstreamPort = await listen(upstream, "127.0.0.1", 0);
    const { store, cleanup } = await tempStore();
    const proxy = await startRecordingProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      store,
      port: 0,
    });
    try {
      const response = await fetch(`${proxy.url}/books/1`, {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret",
          "content-type": "application/json",
          "x-request-id": "visible",
        },
        body: JSON.stringify({ title: "Kindred", password: "hunter2" }),
      });
      const live = await response.json() as { authorization: string; echo: { email: string }; body: { password: string } };
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(live.authorization).toBe("Bearer super-secret");
      expect(live.body.password).toBe("hunter2");
      expect(live.echo.email).toBe("ada@example.com");
      const saved = await store.listExchanges();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.request.path).toBe("/books/1");
      expect(saved[0]?.request.headers.authorization).toBe("[REDACTED]");
      expect(saved[0]?.request.headers["x-request-id"]).toBe("visible");
      expect(JSON.stringify(saved)).not.toContain("super-secret");
      expect(JSON.stringify(saved)).not.toContain("hunter2");
      expect(JSON.stringify(saved)).not.toContain("ada@example.com");
      const files = await store.listSessionFiles();
      const cassette = await readFile(files[0] ?? "", "utf8");
      expect(cassette).toContain("\"_atm\":\"header\"");
      expect(cassette).not.toContain("super-secret");
    } finally {
      await proxy.close();
      await closeServer(upstream);
      await cleanup();
    }
  });

  it("versions incremental windows and skips an unchanged contract", async () => {
    const { store, cleanup } = await tempStore();
    try {
      const session = await store.createSession({
        upstream: "http://upstream.test",
        redaction: { builtins: true, replacement: "[REDACTED]", extraHeaders: 0, extraKeys: 0, extraPatterns: 0 },
      });
      await session.write(exchange({ path: "/health", responseBody: { status: "ok" } }));
      const first = await inferFromStore(store, { title: "Catalog" });
      expect(first.unchanged).toBe(false);
      expect(first.version.operationCount).toBe(1);
      await session.write(exchange({ path: "/health", responseBody: { status: "ok" } }));
      const second = await inferFromStore(store);
      expect(second.unchanged).toBe(true);
      expect(second.empty).toBe(false);
      expect(await store.listVersions()).toHaveLength(1);
      expect((await store.getMeta()).inferredThroughSeq).toBeGreaterThan(first.version.throughSeq);
      const empty = await inferFromStore(store);
      expect(empty.empty).toBe(true);

      await session.write(exchange({ path: "/books/7", responseBody: { id: 7, title: "Dawn" } }));
      const third = await inferFromStore(store);
      expect(third.unchanged).toBe(false);
      expect(third.spec.paths["/books/{bookId}"]?.get).toBeTruthy();
      expect(third.spec.paths["/health"]).toBeUndefined();
      const versions = await store.listVersions();
      const before = await store.loadSpec(versions[0]?.id ?? "");
      const after = await store.loadSpec(versions[1]?.id ?? "");
      const report = diffOpenApi(before, after);
      expect(report.changes.some((change) => change.kind === "endpoint.added" && change.operation.includes("/books/"))).toBe(true);
      expect(report.changes.some((change) => change.kind === "endpoint.removed" && change.operation.includes("/health"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects inference when the store is empty", async () => {
    const { store, cleanup } = await tempStore();
    try {
      await expect(inferFromStore(store)).rejects.toThrow(/No exchanges/);
    } finally {
      await cleanup();
    }
  });
});
