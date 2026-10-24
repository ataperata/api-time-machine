import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BodyEncoding, Exchange, HeaderMap, QueryMap } from "../src/types.js";
import { openStore, type RecordingStore } from "../src/store.js";

let counter = 0;

export function exchange(options: {
  method?: string;
  path: string;
  query?: QueryMap;
  requestBody?: unknown;
  requestEncoding?: BodyEncoding;
  requestHeaders?: HeaderMap;
  status?: number;
  responseBody?: unknown;
  responseEncoding?: BodyEncoding;
  responseHeaders?: HeaderMap;
  sessionId?: string;
  recordedAt?: string;
  contentType?: string;
}): Exchange {
  counter += 1;
  const requestEncoding = options.requestEncoding ?? (options.requestBody === undefined ? "empty" : "json");
  const responseEncoding = options.responseEncoding ?? (options.responseBody === undefined ? "empty" : "json");
  const responseType = options.contentType ?? (responseEncoding === "json" ? "application/json" : undefined);
  const requestType = requestEncoding === "json" ? "application/json" : undefined;
  return {
    id: `ex_${counter}`,
    seq: counter,
    recordedAt: options.recordedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
    sessionId: options.sessionId ?? "ses_test",
    request: {
      method: options.method ?? "GET",
      path: options.path,
      query: options.query ?? {},
      headers: options.requestHeaders ?? {},
      body: options.requestBody ?? null,
      bodyEncoding: requestEncoding,
      ...(requestType ? { contentType: requestType } : {}),
    },
    response: {
      status: options.status ?? 200,
      headers: options.responseHeaders ?? (responseType ? { "content-type": responseType } : {}),
      body: options.responseBody ?? null,
      bodyEncoding: responseEncoding,
      ...(responseType ? { contentType: responseType } : {}),
      durationMs: 4,
    },
  };
}

export async function tempStore(): Promise<{ store: RecordingStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "atm-"));
  const store = await openStore(dir);
  return {
    store,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function ioCapture(): {
  io: { stdout: (chunk: string) => void; stderr: (chunk: string) => void; color: boolean };
  out: () => string;
  err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      color: false,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

export const BOOK_A = { id: 1, title: "Kindred", author: "Butler", price: 16, inStock: true };
export const BOOK_B = { id: 2, title: "Dawn", author: "Butler", price: 18, inStock: true };

export function catalogV1(): Exchange[] {
  return [
    exchange({ path: "/health", responseBody: { status: "ok" } }),
    exchange({ path: "/books", query: { limit: "2" }, responseBody: { books: [BOOK_A, BOOK_B] } }),
    exchange({ path: "/books/1", responseBody: BOOK_A }),
    exchange({ path: "/books/2", responseBody: BOOK_B }),
    exchange({
      method: "POST",
      path: "/books",
      requestBody: { title: "Parable", author: "Butler", price: 20 },
      status: 201,
      responseBody: { id: 3, title: "Parable", author: "Butler", price: 20, inStock: true },
    }),
    exchange({
      path: "/books/1/reviews",
      responseBody: { reviews: [{ id: 9, rating: 5, body: "essential" }] },
    }),
    exchange({
      path: "/authors/10",
      responseBody: { id: 10, name: "Butler", email: "octavia@example.com" },
    }),
  ];
}

export function catalogV2(): Exchange[] {
  const book = { id: 1, title: "Kindred", author: "Butler", price: "16.00", currency: "USD" };
  return [
    exchange({ path: "/health", responseBody: { status: "ok" } }),
    exchange({
      path: "/books",
      query: { limit: "2", cursor: "page-2" },
      responseBody: { books: [book, { ...book, id: 2, title: "Dawn", price: "18.00" }] },
    }),
    exchange({ path: "/books/1", responseBody: book }),
    exchange({ path: "/books/2", responseBody: { ...book, id: 2, title: "Dawn", price: "18.00" } }),
    exchange({
      method: "POST",
      path: "/books",
      requestBody: { title: "Parable", author: "Butler", price: "20.00", isbn: "978-000" },
      status: 201,
      responseBody: { id: 3, title: "Parable", author: "Butler", price: "20.00", currency: "USD", isbn: "978-000" },
    }),
    exchange({
      path: "/books/1/reviews",
      responseBody: { reviews: [{ id: 9, body: "essential" }] },
    }),
    exchange({
      path: "/books/1/related",
      responseBody: { books: [book] },
    }),
  ];
}
