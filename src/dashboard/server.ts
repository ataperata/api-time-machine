import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffOpenApi } from "../diff.js";
import type { RecordingStore } from "../store.js";
import { assertSafeId, UsageError } from "../util.js";
import { closeServer, listen, type RunningServer } from "../http-util.js";
import {
  buildOverview,
  buildTimeline,
  findOperation,
  listOperationKeys,
  summarizeOperations,
} from "./analyze.js";

export interface DashboardOptions {
  store: RecordingStore;
  port?: number;
  host?: string;
}

export function dashboardPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "public"), join(here, "../../src/dashboard/public")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  throw new Error("Dashboard assets not found. Run the build so dist/dashboard/public exists.");
}

export async function startDashboard(options: DashboardOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const publicDir = dashboardPublicDir();
  const indexHtml = readFileSync(join(publicDir, "index.html"));
  const store = options.store;

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      const status = error instanceof UsageError ? 400 : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": indexHtml.length,
      });
      res.end(req.method === "HEAD" ? undefined : indexHtml);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (url.pathname === "/api/overview") {
      sendJson(res, 200, await buildOverview(store));
      return;
    }
    if (url.pathname === "/api/operations") {
      sendJson(res, 200, await listOperationKeys(store));
      return;
    }
    if (url.pathname === "/api/timeline") {
      const method = url.searchParams.get("method");
      const path = url.searchParams.get("path");
      if (!method || !path) throw new UsageError("method and path are required");
      sendJson(res, 200, await buildTimeline(store, method, path));
      return;
    }
    if (url.pathname === "/api/diff") {
      const versions = await store.listVersions();
      const from = url.searchParams.get("from") ?? versions[versions.length - 2]?.id;
      const to = url.searchParams.get("to") ?? versions[versions.length - 1]?.id;
      if (!from || !to) throw new UsageError("Need two spec versions to diff. Run infer at least twice.");
      assertSafeId(from);
      assertSafeId(to);
      const before = await store.loadSpec(from);
      const after = await store.loadSpec(to);
      const fromInfo = versions.find((item) => item.id === from);
      const toInfo = versions.find((item) => item.id === to);
      const report = diffOpenApi(before, after, { from, to });
      sendJson(res, 200, {
        ...report,
        from: { id: from, createdAt: fromInfo?.createdAt, hash: fromInfo?.hash },
        to: { id: to, createdAt: toInfo?.createdAt, hash: toInfo?.hash },
      });
      return;
    }

    const specMatch = /^\/api\/versions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (url.pathname === "/api/versions") {
      sendJson(res, 200, await store.listVersions());
      return;
    }
    if (specMatch) {
      const id = decodeURIComponent(specMatch[1] ?? "");
      assertSafeId(id);
      const rest = specMatch[2] ?? "";
      const spec = await store.loadSpec(id);
      if (rest === "" || rest === "openapi.json") {
        const body = JSON.stringify(spec, null, 2);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          ...(rest === "openapi.json" ? { "content-disposition": `attachment; filename="${id}.json"` } : {}),
        });
        res.end(body);
        return;
      }
      if (rest === "operations") {
        sendJson(res, 200, summarizeOperations(spec));
        return;
      }
      if (rest === "operations/detail") {
        const method = url.searchParams.get("method");
        const path = url.searchParams.get("path");
        if (!method || !path) throw new UsageError("method and path are required");
        const operation = findOperation(spec, method, path);
        if (!operation) {
          sendJson(res, 404, { error: "operation_not_found" });
          return;
        }
        sendJson(res, 200, { method: method.toUpperCase(), path, operation });
        return;
      }
    }
    sendJson(res, 404, { error: "not_found" });
  }

  const port = await listen(server, host, options.port ?? 8789);
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    close: () => closeServer(server),
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
