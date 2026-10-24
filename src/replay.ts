import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Exchange, PreferOrder, ReplayMode } from "./types.js";
import { encodeBody, headerContentType, interpretBody } from "./body.js";
import { closeServer, isHopByHop, listen, type RunningServer } from "./http-util.js";
import { learnPaths, normalizePath, type PathModel } from "./path-template.js";
import type { RecordingStore } from "./store.js";
import { jaccard, parseQuery, queryPairs, splitRequestTarget } from "./url.js";
import { deepEqual, mediaType } from "./util.js";

export interface ReplayRequest {
  method: string;
  path: string;
  query: Exchange["request"]["query"];
  body: unknown;
  bodyEncoding: Exchange["request"]["bodyEncoding"];
  contentType?: string;
}

export interface MatchHit {
  exchange: Exchange;
  score: number;
}

export interface MatchResult {
  hit: MatchHit | null;
  reason: "hit" | "miss";
  considered: number;
}

/**
 * Deterministic matcher.
 *
 * Fuzzy scoring rewards template/exact path, query overlap, and JSON body
 * similarity. Ties break by `prefer` (default newest recordedAt, then id),
 * so the same request always selects the same cassette entry.
 */
export function matchRequest(
  request: ReplayRequest,
  exchanges: Exchange[],
  model: PathModel,
  mode: ReplayMode = "fuzzy",
  prefer: PreferOrder = "newest",
): MatchResult {
  const wantedTemplate = model.resolve(request.path).template;
  const scored: MatchHit[] = [];
  for (const exchange of exchanges) {
    if (exchange.request.method.toUpperCase() !== request.method.toUpperCase()) continue;
    const score = scoreExchange(request, exchange, model, wantedTemplate, mode);
    if (score < 0) continue;
    scored.push({ exchange, score });
  }
  scored.sort((a, b) => compareHits(a, b, prefer));
  const best = scored[0];
  if (!best) return { hit: null, reason: "miss", considered: 0 };
  return { hit: best, reason: "hit", considered: scored.length };
}

function compareHits(a: MatchHit, b: MatchHit, prefer: PreferOrder): number {
  if (a.score !== b.score) return b.score - a.score;
  const time = a.exchange.recordedAt < b.exchange.recordedAt ? -1 : a.exchange.recordedAt > b.exchange.recordedAt ? 1 : 0;
  const id = a.exchange.id < b.exchange.id ? -1 : a.exchange.id > b.exchange.id ? 1 : 0;
  const direction = prefer === "newest" ? -1 : 1;
  return time * direction || id * direction;
}

function scoreExchange(
  request: ReplayRequest,
  exchange: Exchange,
  model: PathModel,
  wantedTemplate: string,
  mode: ReplayMode,
): number {
  const recordedTemplate = model.resolve(exchange.request.path).template;
  const sameTemplate = recordedTemplate === wantedTemplate;
  const exactPath = normalizePath(exchange.request.path) === normalizePath(request.path);
  if (!sameTemplate && !exactPath) return -1;

  if (mode === "strict") {
    if (!exactPath) return -1;
    if (jaccard(queryPairs(request.query), queryPairs(exchange.request.query)) !== 1) return -1;
    if (!bodiesEqual(request, exchange)) return -1;
    return 100;
  }

  if (mode === "path") return exactPath ? 70 : 50;

  let score = 50;
  if (exactPath) score += 20;
  score += jaccard(queryPairs(request.query), queryPairs(exchange.request.query)) * 20;
  score += bodySimilarity(request.body, request.bodyEncoding, exchange.request.body, exchange.request.bodyEncoding) * 20;
  const requestType = mediaType(request.contentType);
  const recordedType = mediaType(exchange.request.contentType ?? exchange.request.headers["content-type"]);
  if (requestType === recordedType) score += 5;
  return score;
}

function bodiesEqual(request: ReplayRequest, exchange: Exchange): boolean {
  const leftEmpty = request.bodyEncoding === "empty";
  const rightEmpty = exchange.request.bodyEncoding === "empty";
  if (leftEmpty && rightEmpty) return true;
  if (leftEmpty || rightEmpty) return false;
  return deepEqual(request.body, exchange.request.body);
}

export function bodySimilarity(
  left: unknown,
  leftEncoding: Exchange["request"]["bodyEncoding"],
  right: unknown,
  rightEncoding: Exchange["request"]["bodyEncoding"],
): number {
  const leftEmpty = leftEncoding === "empty";
  const rightEmpty = rightEncoding === "empty";
  if (leftEmpty && rightEmpty) return 1;
  if (leftEmpty || rightEmpty) return 0;
  if (deepEqual(left, right)) return 1;
  return structuralSimilarity(left, right);
}

function structuralSimilarity(left: unknown, right: unknown): number {
  if (deepEqual(left, right)) return 1;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length === 0 && right.length === 0) return 1;
    const max = Math.max(left.length, right.length);
    if (max === 0) return 1;
    const n = Math.min(left.length, right.length, 5);
    let total = 0;
    for (let i = 0; i < n; i += 1) total += structuralSimilarity(left[i], right[i]);
    const lengthScore = 1 - Math.abs(left.length - right.length) / max;
    return (total / Math.max(n, 1)) * 0.5 + lengthScore * 0.5;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    if (keys.size === 0) return 1;
    let total = 0;
    for (const key of keys) {
      if (key in left && key in right) total += structuralSimilarity(left[key], right[key]);
    }
    return total / keys.size;
  }
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ReplayServerOptions {
  store?: RecordingStore;
  exchanges?: Exchange[];
  port?: number;
  host?: string;
  mode?: ReplayMode;
  prefer?: PreferOrder;
  sessionIds?: string[];
}

export interface RunningReplay extends RunningServer {
  exchanges: number;
  mode: ReplayMode;
}

export async function startReplayServer(options: ReplayServerOptions): Promise<RunningReplay> {
  const loaded = options.exchanges ?? (await options.store?.listExchanges(
    options.sessionIds && options.sessionIds.length > 0 ? { sessionIds: options.sessionIds } : undefined,
  )) ?? [];
  const model = learnPaths(loaded.map((exchange) => exchange.request.path));
  const mode = options.mode ?? "fuzzy";
  const prefer = options.prefer ?? "newest";
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: "replay_error", message }, { "x-atm-replay": "error" });
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    let target: { path: string; search: string };
    try {
      const candidate = rawUrl.startsWith("/") || rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? rawUrl : `/${rawUrl}`;
      target = splitRequestTarget(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: "bad_request", message }, { "x-atm-replay": "miss" });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);
    const headers = flattenIncoming(req.headers);
    const interpreted = interpretBody(buf, headers["content-type"]);
    const request: ReplayRequest = {
      method: (req.method ?? "GET").toUpperCase(),
      path: normalizePath(target.path),
      query: parseQuery(target.search),
      body: interpreted.body,
      bodyEncoding: interpreted.bodyEncoding,
      ...(interpreted.contentType ? { contentType: interpreted.contentType } : {}),
    };
    const result = matchRequest(request, loaded, model, mode, prefer);
    if (!result.hit) {
      sendJson(
        res,
        404,
        {
          error: "no_recording",
          message: `No ${mode} match for ${request.method} ${request.path}`,
        },
        { "x-atm-replay": "miss" },
      );
      return;
    }
    const exchange = result.hit.exchange;
    const body = encodeBody(exchange.response.body, exchange.response.bodyEncoding);
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(exchange.response.headers)) {
      if (isHopByHop(key)) continue;
      if (key === "content-length" || key === "transfer-encoding" || key === "content-encoding") continue;
      out[key] = value;
    }
    const contentType = headerContentType(exchange.response.headers, exchange.response.bodyEncoding, exchange.response.contentType);
    if (contentType && !out["content-type"]) out["content-type"] = contentType;
    out["content-length"] = body.length;
    out["x-atm-replay"] = "hit";
    out["x-atm-exchange-id"] = exchange.id;
    out["x-atm-score"] = result.hit.score.toFixed(2);
    res.writeHead(exchange.response.status, out);
    res.end(body);
  }

  const port = await listen(server, host, options.port ?? 8788);
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    exchanges: loaded.length,
    mode,
    close: () => closeServer(server),
  };
}

function flattenIncoming(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string>): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}
