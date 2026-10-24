import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Exchange, RedactionConfig } from "./types.js";
import { decodeCompressed, flattenHeaders, interpretBody } from "./body.js";
import { closeServer, isHopByHop, listen, type RunningServer } from "./http-util.js";
import { normalizePath } from "./path-template.js";
import { compileRedaction, defaultRedactionConfig, redactExchange } from "./redact.js";
import { RecordingStore, type SessionWriter } from "./store.js";
import { buildUpstreamUrl, parseQuery, splitRequestTarget } from "./url.js";
import { newId } from "./util.js";

export interface ProxyOptions {
  upstream: string;
  store: RecordingStore;
  port?: number;
  host?: string;
  redaction?: RedactionConfig;
  sessionName?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  match?: string;
  insecure?: boolean;
  log?: (message: string) => void;
}

export interface RunningProxy extends RunningServer {
  sessionId: string;
}

const DEFAULT_MAX_BODY = 5 * 1024 * 1024;

export async function startRecordingProxy(options: ProxyOptions): Promise<RunningProxy> {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`Unsupported upstream protocol: ${upstream.protocol}`);
  }
  const redaction = options.redaction ?? defaultRedactionConfig();
  const compiled = compileRedaction(redaction);
  const session: SessionWriter = await options.store.createSession({
    upstream: options.upstream,
    ...(options.sessionName ? { name: options.sessionName } : {}),
    redaction: {
      builtins: redaction.builtins,
      replacement: redaction.replacement,
      extraHeaders: redaction.headers.length,
      extraKeys: redaction.jsonKeys.length,
      extraPatterns: redaction.valuePatterns.length,
    },
  });
  const host = options.host ?? "127.0.0.1";
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const log = options.log ?? (() => undefined);

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`proxy error: ${message}`);
      if (!res.headersSent) {
        const body = JSON.stringify({ error: "proxy_error", message });
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
        res.end(body);
      } else {
        res.end();
      }
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    let target: { path: string; search: string };
    try {
      target = splitRequestTarget(rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: "bad_request", message });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, maxBody);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "LIMIT") {
        sendJson(res, 413, { error: "payload_too_large", message: `body exceeds ${maxBody} bytes` });
        return;
      }
      throw error;
    }
    const started = performance.now();
    let upstreamResult: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
    try {
      const url = buildUpstreamUrl(options.upstream, `${target.path}${target.search}`);
      upstreamResult = await forward({
        url,
        method: req.method ?? "GET",
        headers: req.headers,
        body,
        timeoutMs,
        insecure: options.insecure ?? false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`upstream ${req.method} ${target.path} failed: ${message}`);
      sendJson(res, 502, { error: "bad_gateway", message });
      return;
    }
    const decoded = decodeCompressed(upstreamResult.body, headerValue(upstreamResult.headers["content-encoding"]));
    const responseHeaders = flattenHeaders(upstreamResult.headers);
    delete responseHeaders["content-encoding"];
    delete responseHeaders["transfer-encoding"];
    delete responseHeaders["content-length"];

    const path = normalizePath(target.path);
    const shouldRecord = !options.match || path.startsWith(options.match);
    if (shouldRecord) {
      const requestHeaders = flattenHeaders(req.headers);
      const requestBody = interpretBody(body, requestHeaders["content-type"]);
      const responseBody = interpretBody(decoded, responseHeaders["content-type"]);
      const exchange: Exchange = {
        id: newId("ex"),
        recordedAt: new Date().toISOString(),
        sessionId: session.sessionId,
        request: {
          method: (req.method ?? "GET").toUpperCase(),
          path,
          query: parseQuery(target.search),
          headers: requestHeaders,
          body: requestBody.body,
          bodyEncoding: requestBody.bodyEncoding,
          ...(requestBody.contentType ? { contentType: requestBody.contentType } : {}),
        },
        response: {
          status: upstreamResult.status,
          headers: responseHeaders,
          body: responseBody.body,
          bodyEncoding: responseBody.bodyEncoding,
          ...(responseBody.contentType ? { contentType: responseBody.contentType } : {}),
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        },
      };
      try {
        await session.write(redactExchange(exchange, redaction));
        log(`${exchange.request.method} ${path} → ${upstreamResult.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`failed to record ${path}: ${message}`);
      }
    }
    writeUpstream(res, upstreamResult.status, upstreamResult.headers, decoded);
  }

  // Compile at startup so an invalid redaction regex fails before traffic arrives.
  void compiled;

  const port = await listen(server, host, options.port ?? 8787);
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    sessionId: session.sessionId,
    close: () => closeServer(server),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeUpstream(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): void {
  const out: Record<string, string | string[] | number> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (isHopByHop(lower) || lower === "content-encoding" || lower === "transfer-encoding") continue;
    out[lower] = value;
  }
  out["content-length"] = body.length;
  res.writeHead(status, out);
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        reject(Object.assign(new Error("body too large"), { code: "LIMIT" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function forward(options: {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  timeoutMs: number;
  insecure: boolean;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(options.url);
  const isHttps = url.protocol === "https:";
  const headers: Record<string, string | string[] | number | undefined> = {};
  for (const [key, value] of Object.entries(options.headers)) {
    if (value === undefined) continue;
    if (isHopByHop(key) || key.toLowerCase() === "accept-encoding") continue;
    headers[key] = value;
  }
  headers.host = url.host;
  if (options.body.length > 0 || !["GET", "HEAD"].includes(options.method.toUpperCase())) {
    headers["content-length"] = options.body.length;
  } else {
    delete headers["content-length"];
  }
  const libRequest = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = libRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method: options.method,
        path: `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: !options.insecure,
        timeout: options.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end(options.body.length > 0 ? options.body : undefined);
  });
}
