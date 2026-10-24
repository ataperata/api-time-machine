import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffOpenApi, inferFromStore, openStore, startRecordingProxy, startReplayServer } from "../dist/index.js";
import { startUpstream } from "./upstream.mjs";

const dir = await mkdtemp(join(tmpdir(), "atm-demo-"));
const store = await openStore(dir);
let upstream;
let proxy;
let replay;

try {
  upstream = await startUpstream({ version: 1 });
  proxy = await startRecordingProxy({ upstream: upstream.url, store, port: 0 });
  await send(proxy.url, "GET", "/health");
  await send(proxy.url, "GET", "/books");
  await send(proxy.url, "GET", "/books/1");
  await send(proxy.url, "GET", "/books/2");
  await send(proxy.url, "POST", "/books", {
    headers: { authorization: "Bearer super-secret", "content-type": "application/json" },
    body: { title: "Parable", author: "Butler", price: 20, password: "hunter2" },
  });
  await send(proxy.url, "GET", "/books/1/reviews");
  await send(proxy.url, "GET", "/authors/10");
  await proxy.close();
  proxy = undefined;

  const v1 = await inferFromStore(store, { title: "Bookstore" });
  if (!v1.spec.paths["/authors/{authorId}"]?.get) throw new Error("v1 spec missed authors");
  if (!v1.spec.paths["/books/{bookId}"]?.get) throw new Error("v1 spec missed books");

  const cassette = await readCassettes(dir);
  if (cassette.includes("super-secret") || cassette.includes("hunter2") || cassette.includes("octavia@example.com")) {
    throw new Error("cassette leaked a secret or email");
  }

  await upstream.close();
  upstream = await startUpstream({ version: 2 });
  proxy = await startRecordingProxy({ upstream: upstream.url, store, port: 0 });
  await send(proxy.url, "GET", "/health");
  await send(proxy.url, "GET", "/books?cursor=page-2");
  await send(proxy.url, "GET", "/books/1");
  await send(proxy.url, "GET", "/books/2");
  await send(proxy.url, "POST", "/books", {
    headers: { "content-type": "application/json" },
    body: { title: "Parable", author: "Butler", price: "20.00", isbn: "978-000" },
  });
  await send(proxy.url, "GET", "/books/1/reviews");
  await send(proxy.url, "GET", "/books/1/related");
  await proxy.close();
  proxy = undefined;

  const v2 = await inferFromStore(store, { title: "Bookstore" });
  const report = diffOpenApi(v1.spec, v2.spec, { from: v1.version.id, to: v2.version.id });
  const kinds = new Set(report.changes.map((change) => `${change.level}:${change.kind}`));
  for (const expected of [
    "breaking:endpoint.removed",
    "breaking:query.added",
    "breaking:request.field.added",
    "breaking:response.type.changed",
    "breaking:response.field.removed",
    "info:endpoint.added",
  ]) {
    if (!kinds.has(expected)) {
      throw new Error(`missing ${expected}\n${report.changes.map((change) => `${change.level} ${change.kind} ${change.pointer}`).join("\n")}`);
    }
  }

  replay = await startReplayServer({ store, port: 0, mode: "fuzzy" });
  const author = await fetch(`${replay.url}/authors/999`);
  const authorBody = await author.json();
  if (author.headers.get("x-atm-replay") !== "hit" || authorBody.email !== "[REDACTED]") {
    throw new Error(`author replay failed: ${author.status} ${JSON.stringify(authorBody)}`);
  }
  const book = await fetch(`${replay.url}/books/999`);
  const bookBody = await book.json();
  if (book.headers.get("x-atm-replay") !== "hit" || typeof bookBody.price !== "string") {
    throw new Error(`book replay did not prefer the newest contract: ${JSON.stringify(bookBody)}`);
  }
  const miss = await fetch(`${replay.url}/not-a-route`);
  if (miss.status !== 404 || miss.headers.get("x-atm-replay") !== "miss") {
    throw new Error("expected a replay miss");
  }

  console.log(`walkthrough ok`);
  console.log(`  v1 ${v1.version.id} operations=${v1.version.operationCount}`);
  console.log(`  v2 ${v2.version.id} operations=${v2.version.operationCount}`);
  console.log(`  diff breaking=${report.summary.breaking} warning=${report.summary.warning} info=${report.summary.info}`);
} finally {
  await proxy?.close().catch(() => undefined);
  await replay?.close().catch(() => undefined);
  await upstream?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}

async function send(base, method, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function readCassettes(root) {
  const names = await readdir(join(root, "recordings"));
  const chunks = [];
  for (const name of names) chunks.push(await readFile(join(root, "recordings", name), "utf8"));
  return chunks.join("\n");
}
