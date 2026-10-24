import { describe, expect, it } from "vitest";
import { learnPaths } from "../src/path-template.js";
import { matchRequest, startReplayServer } from "../src/replay.js";
import type { Exchange } from "../src/types.js";
import { exchange } from "./helpers.js";

function replayRequest(path: string, extra?: { method?: string; query?: Exchange["request"]["query"]; body?: unknown }): Parameters<typeof matchRequest>[0] {
  return {
    method: extra?.method ?? "GET",
    path,
    query: extra?.query ?? {},
    body: extra?.body ?? null,
    bodyEncoding: extra?.body === undefined ? "empty" : "json",
    ...(extra?.body !== undefined ? { contentType: "application/json" } : {}),
  };
}

describe("replay matching", () => {
  const older = exchange({
    path: "/users/1",
    query: { verbose: "true" },
    responseBody: { id: 1, generation: "old" },
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const newer = exchange({
    path: "/users/2",
    query: { verbose: "false" },
    responseBody: { id: 2, generation: "new" },
    recordedAt: "2026-02-01T00:00:00.000Z",
  });
  const posted = exchange({
    method: "POST",
    path: "/users",
    requestBody: { name: "Ada" },
    status: 201,
    responseBody: { id: 3, name: "Ada" },
  });
  const alias = exchange({ path: "/users/me", responseBody: { id: "self" } });
  const recordings = [older, newer, posted, alias];
  const model = learnPaths(recordings.map((item) => item.request.path));

  it("fuzzy-matches path params and prefers the closer query", () => {
    const hit = matchRequest(replayRequest("/users/9", { query: { verbose: "true" } }), recordings, model, "fuzzy");
    expect(hit.hit?.exchange.id).toBe(older.id);
    const exact = matchRequest(replayRequest("/users/2", { query: { verbose: "false" } }), recordings, model, "fuzzy");
    expect(exact.hit?.exchange.id).toBe(newer.id);
  });

  it("breaks ties toward the newest recording", () => {
    const same = exchange({
      path: "/users/1",
      query: { verbose: "true" },
      responseBody: { id: 1, generation: "newer-same" },
      recordedAt: "2026-03-01T00:00:00.000Z",
    });
    const hit = matchRequest(replayRequest("/users/1", { query: { verbose: "true" } }), [older, same], model, "fuzzy", "newest");
    expect(hit.hit?.exchange.id).toBe(same.id);
    const oldest = matchRequest(replayRequest("/users/1", { query: { verbose: "true" } }), [older, same], model, "fuzzy", "oldest");
    expect(oldest.hit?.exchange.id).toBe(older.id);
  });

  it("keeps strict mode exact and path mode template-only", () => {
    const strictMiss = matchRequest(replayRequest("/users/1", { query: { verbose: "false" } }), recordings, model, "strict");
    expect(strictMiss.reason).toBe("miss");
    const strictHit = matchRequest(replayRequest("/users/1", { query: { verbose: "true" } }), recordings, model, "strict");
    expect(strictHit.reason).toBe("hit");
    const pathHit = matchRequest(replayRequest("/users/44", { query: { verbose: "true" } }), recordings, model, "path", "oldest");
    expect(pathHit.hit?.exchange.id).toBe(older.id);
    const post = matchRequest(replayRequest("/users", { method: "POST", body: { name: "Ada", extra: true } }), recordings, model, "fuzzy");
    expect(post.hit?.exchange.id).toBe(posted.id);
    expect(matchRequest(replayRequest("/missing"), recordings, model).reason).toBe("miss");
  });

  it("serves a deterministic mock over HTTP", async () => {
    const server = await startReplayServer({ exchanges: recordings, port: 0, mode: "fuzzy" });
    try {
      const hit = await fetch(`${server.url}/users/50?verbose=true`);
      expect(hit.headers.get("x-atm-replay")).toBe("hit");
      expect(hit.headers.get("x-atm-exchange-id")).toBe(older.id);
      expect(await hit.json()).toEqual({ id: 1, generation: "old" });
      const again = await fetch(`${server.url}/users/50?verbose=true`);
      expect(again.headers.get("x-atm-exchange-id")).toBe(older.id);
      const miss = await fetch(`${server.url}/nope`);
      expect(miss.status).toBe(404);
      expect(miss.headers.get("x-atm-replay")).toBe("miss");
      const me = await fetch(`${server.url}/users/me`);
      expect(await me.json()).toEqual({ id: "self" });
    } finally {
      await server.close();
    }
  });
});
