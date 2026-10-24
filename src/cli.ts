#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diffOpenApi, formatDiffReport } from "./diff.js";
import { inferFromStore } from "./infer.js";
import { startRecordingProxy } from "./proxy.js";
import { redactionFromJson } from "./redact.js";
import { startReplayServer } from "./replay.js";
import { startDashboard } from "./dashboard/server.js";
import { openStore } from "./store.js";
import type { PreferOrder, ReplayMode } from "./types.js";
import { parsePort, UsageError } from "./util.js";

export interface IO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  color: boolean;
}

const defaultIo: IO = {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  color: Boolean(process.stdout.isTTY),
};

export function generalHelp(): string {
  return `api-time-machine — record an API, infer OpenAPI 3.1, diff versions, replay it

Usage:
  atm record --upstream <url> [--port 8787] [--store .atm] [--redact file]
  atm infer [--store .atm] [--all] [--session id] [--title name] [--force] [--json]
  atm diff [--store .atm] [--from id] [--to id] [--json] [--fail-on breaking|warning|none]
  atm replay [--store .atm] [--port 8788] [--mode fuzzy|strict|path] [--prefer newest|oldest]
  atm dashboard [--store .atm] [--port 8789]
  atm versions [--store .atm] [--json]

The record proxy stores redacted exchanges. infer snapshots the next traffic
window into an OpenAPI version. diff reports breaking client changes. replay
serves a deterministic mock from the cassette. dashboard shows endpoints,
schema evolution, and the breaking-change report.
`;
}

export async function main(argv: string[], io: IO = defaultIo, signal?: AbortSignal): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(generalHelp());
      return 0;
    }
    switch (command) {
      case "record":
        return await cmdRecord(rest, io, signal);
      case "infer":
        return await cmdInfer(rest, io);
      case "diff":
        return await cmdDiff(rest, io);
      case "replay":
        return await cmdReplay(rest, io, signal);
      case "dashboard":
        return await cmdDashboard(rest, io, signal);
      case "versions":
        return await cmdVersions(rest, io);
      default:
        io.stderr(`Unknown command: ${command}\n`);
        io.stdout(generalHelp());
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof Error) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`${String(error)}\n`);
    return 2;
  }
}

async function cmdRecord(args: string[], io: IO, signal?: AbortSignal): Promise<number> {
  const { values } = parse(args, {
    upstream: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    store: { type: "string", default: ".atm" },
    redact: { type: "string" },
    session: { type: "string" },
    match: { type: "string" },
    timeout: { type: "string" },
    insecure: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm record --upstream <url> [--port 8787] [--store .atm] [--redact file] [--match /prefix]\n");
    return 0;
  }
  if (!values.upstream) throw new UsageError("record requires --upstream");
  const store = await openStore(resolve(values.store ?? ".atm"));
  const redaction = values.redact ? redactionFromJson(JSON.parse(await readFile(values.redact, "utf8"))) : undefined;
  const proxy = await startRecordingProxy({
    upstream: values.upstream,
    store,
    port: parsePort(values.port, 8787),
    ...(values.host ? { host: values.host } : {}),
    ...(redaction ? { redaction } : {}),
    ...(values.session ? { sessionName: values.session } : {}),
    ...(values.match ? { match: values.match } : {}),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
    insecure: values.insecure,
    log: values.verbose ? (message) => io.stderr(`${message}\n`) : undefined,
  });
  io.stderr(`recording ${proxy.url} → ${values.upstream}\nstore: ${store.root}\nsession: ${proxy.sessionId}\n`);
  await waitForStop(signal);
  await proxy.close();
  io.stderr("recording stopped\n");
  return 0;
}

async function cmdInfer(args: string[], io: IO): Promise<number> {
  const { values } = parse(args, {
    store: { type: "string", default: ".atm" },
    title: { type: "string" },
    all: { type: "boolean", default: false },
    session: { type: "string", multiple: true },
    force: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm infer [--store .atm] [--all | --session id] [--title name] [--force] [--json]\n");
    return 0;
  }
  const store = await openStore(resolve(values.store ?? ".atm"));
  const result = await inferFromStore(store, {
    ...(values.title ? { title: values.title } : {}),
    all: values.all,
    ...(values.session ? { sessionIds: values.session } : {}),
    force: values.force,
  });
  const payload = {
    id: result.version.id,
    unchanged: result.unchanged,
    empty: result.empty,
    windowSize: result.windowSize,
    operationCount: result.version.operationCount,
    hash: result.version.hash,
    file: result.version.file,
  };
  if (values.json) {
    io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (result.empty) {
    io.stdout(`No new exchanges since ${result.version.id}.\n`);
    return 0;
  }
  if (result.unchanged) {
    io.stdout(`No contract change since ${result.version.id} (${result.windowSize} new exchanges). Watermark advanced.\n`);
    return 0;
  }
  io.stdout(`inferred ${result.version.id}\n  operations: ${result.version.operationCount}\n  exchanges: ${result.windowSize}\n  hash: ${result.version.hash.slice(0, 12)}\n  wrote ${store.root}/${result.version.file}\n`);
  for (const path of Object.keys(result.spec.paths).sort()) {
    const methods = Object.keys(result.spec.paths[path] ?? {}).sort();
    for (const method of methods) io.stdout(`  ${method.toUpperCase().padEnd(6)} ${path}\n`);
  }
  return 0;
}

async function cmdDiff(args: string[], io: IO): Promise<number> {
  const { values } = parse(args, {
    store: { type: "string", default: ".atm" },
    from: { type: "string" },
    to: { type: "string" },
    json: { type: "boolean", default: false },
    "fail-on": { type: "string", default: "breaking" },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm diff [--store .atm] [--from id --to id] [--json] [--fail-on breaking|warning|none]\n");
    return 0;
  }
  const failOn = values["fail-on"] ?? "breaking";
  if (!["breaking", "warning", "none"].includes(failOn)) {
    throw new UsageError("--fail-on must be breaking, warning, or none");
  }
  const store = await openStore(resolve(values.store ?? ".atm"));
  const versions = await store.listVersions();
  if (versions.length < 2 && !(values.from && values.to)) {
    throw new UsageError("Need two spec versions. Run infer after a second traffic window.");
  }
  const from = values.from ?? versions[versions.length - 2]?.id;
  const to = values.to ?? versions[versions.length - 1]?.id;
  if (!from || !to) throw new UsageError("Could not resolve --from and --to");
  const before = await store.loadSpec(from);
  const after = await store.loadSpec(to);
  const fromInfo = versions.find((item) => item.id === from);
  const toInfo = versions.find((item) => item.id === to);
  const report = {
    ...diffOpenApi(before, after, { from, to }),
    from: { id: from, createdAt: fromInfo?.createdAt, hash: fromInfo?.hash },
    to: { id: to, createdAt: toInfo?.createdAt, hash: toInfo?.hash },
  };
  if (values.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout(`${formatDiffReport(report, io.color)}\n`);
  if (failOn === "none") return 0;
  if (failOn === "warning") return report.summary.breaking + report.summary.warning > 0 ? 1 : 0;
  return report.summary.breaking > 0 ? 1 : 0;
}

async function cmdReplay(args: string[], io: IO, signal?: AbortSignal): Promise<number> {
  const { values } = parse(args, {
    store: { type: "string", default: ".atm" },
    port: { type: "string" },
    host: { type: "string" },
    mode: { type: "string", default: "fuzzy" },
    prefer: { type: "string", default: "newest" },
    session: { type: "string", multiple: true },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm replay [--store .atm] [--port 8788] [--mode fuzzy|strict|path] [--prefer newest|oldest]\n");
    return 0;
  }
  const mode = values.mode as ReplayMode;
  const prefer = values.prefer as PreferOrder;
  if (!["fuzzy", "strict", "path"].includes(mode)) throw new UsageError("--mode must be fuzzy, strict, or path");
  if (!["newest", "oldest"].includes(prefer)) throw new UsageError("--prefer must be newest or oldest");
  const store = await openStore(resolve(values.store ?? ".atm"));
  const server = await startReplayServer({
    store,
    port: parsePort(values.port, 8788),
    ...(values.host ? { host: values.host } : {}),
    mode,
    prefer,
    ...(values.session ? { sessionIds: values.session } : {}),
  });
  io.stderr(`replay ${server.url}  mode=${mode} prefer=${prefer} exchanges=${server.exchanges}\n`);
  await waitForStop(signal);
  await server.close();
  return 0;
}

async function cmdDashboard(args: string[], io: IO, signal?: AbortSignal): Promise<number> {
  const { values } = parse(args, {
    store: { type: "string", default: ".atm" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm dashboard [--store .atm] [--port 8789]\n");
    return 0;
  }
  const store = await openStore(resolve(values.store ?? ".atm"));
  const server = await startDashboard({
    store,
    port: parsePort(values.port, 8789),
    ...(values.host ? { host: values.host } : {}),
  });
  io.stderr(`dashboard ${server.url}\n`);
  await waitForStop(signal);
  await server.close();
  return 0;
}

async function cmdVersions(args: string[], io: IO): Promise<number> {
  const { values } = parse(args, {
    store: { type: "string", default: ".atm" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  });
  if (values.help) {
    io.stdout("atm versions [--store .atm] [--json]\n");
    return 0;
  }
  const store = await openStore(resolve(values.store ?? ".atm"));
  const [versions, meta, exchanges] = await Promise.all([
    store.listVersions(),
    store.getMeta(),
    store.listExchanges(),
  ]);
  if (values.json) {
    io.stdout(`${JSON.stringify({ exchanges: exchanges.length, ...meta, versions }, null, 2)}\n`);
    return 0;
  }
  io.stdout(`store: ${store.root}\nexchanges: ${exchanges.length}\ninferred through seq: ${meta.inferredThroughSeq}\nversions: ${versions.length}\n`);
  if (versions.length === 0) return 0;
  io.stdout("\n");
  for (const version of versions) {
    io.stdout(`${version.id}  ops=${version.operationCount}  exchanges=${version.exchangeCount}  seq=${version.fromSeq}-${version.throughSeq}  ${version.source}\n`);
  }
  return 0;
}

function parse<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean; default?: string | boolean }>>(
  args: string[],
  options: T,
): { values: { [K in keyof T]: T[K] extends { multiple: true } ? string[] | undefined : T[K] extends { type: "boolean" } ? boolean | undefined : string | undefined } } {
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: false });
    return { values: parsed.values as never };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(message);
  }
}

function waitForStop(signal?: AbortSignal): Promise<void> {
  if (signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolvePromise) => {
      signal.addEventListener("abort", () => resolvePromise(), { once: true });
    });
  }
  return new Promise((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const invokedDirectly = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
