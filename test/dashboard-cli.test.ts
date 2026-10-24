import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { inferFromStore } from "../src/infer.js";
import { startDashboard } from "../src/dashboard/server.js";
import { catalogV1, catalogV2, ioCapture, tempStore } from "./helpers.js";

async function seed(dir: string): Promise<void> {
  const { openStore } = await import("../src/store.js");
  const store = await openStore(dir);
  const first = await store.createSession({
    name: "v1",
    redaction: { builtins: true, replacement: "[REDACTED]", extraHeaders: 0, extraKeys: 0, extraPatterns: 0 },
  });
  for (const item of catalogV1()) await first.write(item);
  await inferFromStore(store, { title: "Catalog" });
  const second = await store.createSession({
    name: "v2",
    redaction: { builtins: true, replacement: "[REDACTED]", extraHeaders: 0, extraKeys: 0, extraPatterns: 0 },
  });
  for (const item of catalogV2()) await second.write(item);
  await inferFromStore(store, { title: "Catalog" });
}

describe("dashboard", () => {
  it("serves overview, timeline, and breaking-change JSON", async () => {
    const { dir, cleanup, store } = await tempStore();
    try {
      await seed(dir);
      const dashboard = await startDashboard({ store, port: 0 });
      try {
        const html = await fetch(`${dashboard.url}/`);
        expect(html.headers.get("content-type")).toContain("text/html");
        const page = await html.text();
        expect(page).toContain("api-time-machine");
        expect(page).toContain("Breaking changes");
        expect(page).not.toContain("<script>alert");
        const overview = await (await fetch(`${dashboard.url}/api/overview`)).json() as { versions: Array<{ id: string }>; exchanges: number };
        expect(overview.versions).toHaveLength(2);
        expect(overview.exchanges).toBe(catalogV1().length + catalogV2().length);
        const ops = await (await fetch(`${dashboard.url}/api/versions/${overview.versions[1]?.id}/operations`)).json() as Array<{ path: string }>;
        expect(ops.some((op) => op.path === "/books/{bookId}")).toBe(true);
        const diff = await (await fetch(`${dashboard.url}/api/diff`)).json() as { summary: { breaking: number }; changes: Array<{ kind: string }> };
        expect(diff.summary.breaking).toBeGreaterThan(0);
        expect(diff.changes.some((change) => change.kind === "endpoint.removed")).toBe(true);
        const timeline = await (await fetch(`${dashboard.url}/api/timeline?method=GET&path=${encodeURIComponent("/books/{bookId}")}`)).json() as Array<{ present: boolean; changes: unknown[] }>;
        expect(timeline).toHaveLength(2);
        expect(timeline[0]?.present).toBe(true);
        expect(timeline[1]?.changes.length).toBeGreaterThan(0);
        const missing = await fetch(`${dashboard.url}/api/versions/nope/openapi.json`);
        expect(missing.status).toBe(400);
      } finally {
        await dashboard.close();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("cli", () => {
  it("prints help and rejects unknown commands", async () => {
    const help = ioCapture();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("atm record");
    const unknown = ioCapture();
    expect(await main(["nope"], unknown.io)).toBe(2);
  });

  it("infers, lists versions, diffs with a failing exit code, and replays", async () => {
    const { dir, cleanup } = await tempStore();
    try {
      await seed(dir);
      const versions = ioCapture();
      expect(await main(["versions", "--store", dir], versions.io)).toBe(0);
      expect(versions.out()).toContain("versions: 2");
      const diff = ioCapture();
      expect(await main(["diff", "--store", dir, "--json"], diff.io)).toBe(1);
      const report = JSON.parse(diff.out()) as { summary: { breaking: number } };
      expect(report.summary.breaking).toBeGreaterThan(0);
      const ok = ioCapture();
      expect(await main(["diff", "--store", dir, "--fail-on", "none"], ok.io)).toBe(0);
      const replayIo = ioCapture();
      const controller = new AbortController();
      const pending = main(["replay", "--store", dir, "--port", "0", "--mode", "fuzzy"], replayIo.io, controller.signal);
      const url = await waitForUrl(replayIo.err);
      const response = await fetch(`${url}/books/99`);
      expect(response.headers.get("x-atm-replay")).toBe("hit");
      expect(response.status).toBe(200);
      controller.abort();
      expect(await pending).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

async function waitForUrl(read: () => string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const match = read().match(/replay (http:\/\/127\.0\.0\.1:\d+)/);
    if (match?.[1]) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`replay did not start:\n${read()}`);
}
