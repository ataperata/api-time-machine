import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exchange, OpenApiDocument, SessionHeader, VersionInfo } from "./types.js";
import { compareCursor, countOperations, newId, sha256, stamp, stripNonContract, canonicalize, UsageError, assertSafeId } from "./util.js";

interface MetaFile {
  format: 1;
  nextSeq: number;
  inferredThroughSeq: number;
}

interface IndexFile {
  format: 1;
  versions: VersionInfo[];
}

const EMPTY_META: MetaFile = { format: 1, nextSeq: 1, inferredThroughSeq: 0 };

export interface SessionWriter {
  sessionId: string;
  file: string;
  write: (exchange: Exchange) => Promise<Exchange>;
}

/**
 * Filesystem cassette + spec version store.
 *
 * ```
 * <root>/meta.json
 * <root>/recordings/<session>.jsonl
 * <root>/specs/index.json
 * <root>/specs/<version>.json
 * ```
 *
 * Inference windows default to exchanges with `seq` greater than
 * `inferredThroughSeq`, so each version describes one coherent slice of
 * traffic instead of the union of every historical shape.
 */
export class RecordingStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.root, "recordings"), { recursive: true });
    await mkdir(join(this.root, "specs"), { recursive: true });
    try {
      await readFile(this.metaPath(), "utf8");
    } catch {
      await this.atomicWrite(this.metaPath(), JSON.stringify(EMPTY_META, null, 2) + "\n");
    }
    try {
      await readFile(this.indexPath(), "utf8");
    } catch {
      await this.atomicWrite(this.indexPath(), JSON.stringify({ format: 1, versions: [] } satisfies IndexFile, null, 2) + "\n");
    }
    await this.healSeq();
  }

  private metaPath(): string {
    return join(this.root, "meta.json");
  }

  private indexPath(): string {
    return join(this.root, "specs", "index.json");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async atomicWrite(file: string, data: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  private async readMeta(): Promise<MetaFile> {
    const raw = await readFile(this.metaPath(), "utf8");
    const parsed = JSON.parse(raw) as MetaFile;
    return {
      format: 1,
      nextSeq: parsed.nextSeq ?? 1,
      inferredThroughSeq: parsed.inferredThroughSeq ?? 0,
    };
  }

  private async writeMeta(meta: MetaFile): Promise<void> {
    await this.atomicWrite(this.metaPath(), JSON.stringify(meta, null, 2) + "\n");
  }

  private async readIndex(): Promise<IndexFile> {
    const raw = await readFile(this.indexPath(), "utf8");
    const parsed = JSON.parse(raw) as IndexFile;
    return { format: 1, versions: parsed.versions ?? [] };
  }

  private async healSeq(): Promise<void> {
    await this.exclusive(async () => {
      const exchanges = await this.readAllExchanges();
      const meta = await this.readMeta();
      const maxSeq = exchanges.reduce((max, exchange) => Math.max(max, exchange.seq ?? 0), 0);
      if (meta.nextSeq <= maxSeq) meta.nextSeq = maxSeq + 1;
      await this.writeMeta(meta);
    });
  }

  async getMeta(): Promise<MetaFile> {
    return this.readMeta();
  }

  async createSession(options: {
    upstream?: string;
    name?: string;
    redaction: SessionHeader["redaction"];
  }): Promise<SessionWriter> {
    return this.exclusive(async () => {
      const sessionId = newId("ses");
      const file = join(this.root, "recordings", `${sessionId}.jsonl`);
      const header: SessionHeader = {
        _atm: "header",
        format: 1,
        sessionId,
        ...(options.name ? { name: options.name } : {}),
        ...(options.upstream ? { upstream: options.upstream } : {}),
        startedAt: new Date().toISOString(),
        redaction: options.redaction,
      };
      await writeFile(file, JSON.stringify(header) + "\n");
      return {
        sessionId,
        file,
        write: (exchange) => this.appendExchange(file, { ...exchange, sessionId }),
      };
    });
  }

  private async appendExchange(file: string, exchange: Exchange): Promise<Exchange> {
    return this.exclusive(async () => {
      const meta = await this.readMeta();
      const stored: Exchange = {
        ...exchange,
        seq: meta.nextSeq,
        recordedAt: exchange.recordedAt || new Date().toISOString(),
      };
      meta.nextSeq += 1;
      await appendFile(file, JSON.stringify(stored) + "\n");
      await this.writeMeta(meta);
      return stored;
    });
  }

  async listSessionFiles(): Promise<string[]> {
    const dir = join(this.root, "recordings");
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(".jsonl")).sort().map((name) => join(dir, name));
  }

  async listSessions(): Promise<SessionHeader[]> {
    const files = await this.listSessionFiles();
    const headers: SessionHeader[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const first = text.split(/\n/, 1)[0];
      if (!first) continue;
      const parsed = JSON.parse(first) as SessionHeader;
      if (parsed._atm === "header") headers.push(parsed);
    }
    return headers;
  }

  private async readAllExchanges(): Promise<Exchange[]> {
    const files = await this.listSessionFiles();
    const exchanges: Exchange[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const lines = text.split(/\n/);
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${file}:${lineNo}: ${message}`);
        }
        if (parsed && typeof parsed === "object" && (parsed as SessionHeader)._atm === "header") continue;
        exchanges.push(parsed as Exchange);
      }
    }
    let synthetic = 1;
    for (const exchange of exchanges) {
      if (typeof exchange.seq !== "number") {
        while (exchanges.some((item) => item.seq === synthetic)) synthetic += 1;
        exchange.seq = synthetic;
        synthetic += 1;
      }
    }
    exchanges.sort(compareCursor);
    return exchanges;
  }

  async listExchanges(filter?: { sessionIds?: string[] }): Promise<Exchange[]> {
    const all = await this.readAllExchanges();
    if (!filter?.sessionIds || filter.sessionIds.length === 0) return all;
    const allow = new Set(filter.sessionIds);
    return all.filter((exchange) => allow.has(exchange.sessionId));
  }

  async listVersions(): Promise<VersionInfo[]> {
    const index = await this.readIndex();
    return [...index.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async loadSpec(id: string): Promise<OpenApiDocument> {
    assertSafeId(id);
    const versions = await this.listVersions();
    const version = versions.find((item) => item.id === id);
    if (!version) throw new UsageError(`Unknown spec version: ${id}`);
    const raw = await readFile(join(this.root, "specs", `${id}.json`), "utf8");
    return JSON.parse(raw) as OpenApiDocument;
  }

  /**
   * Persist a spec version. Identical contracts in incremental mode advance the
   * watermark without creating a duplicate version.
   */
  async commitSpec(options: {
    spec: OpenApiDocument;
    title: string;
    exchangeCount: number;
    sessionIds: string[];
    fromSeq: number;
    throughSeq: number;
    source: VersionInfo["source"];
    force?: boolean;
    advanceWatermark?: boolean;
  }): Promise<{ version: VersionInfo; unchanged: boolean; spec: OpenApiDocument }> {
    return this.exclusive(async () => {
      const hash = specHash(options.spec);
      const index = await this.readIndex();
      const latest = index.versions[index.versions.length - 1];
      const meta = await this.readMeta();

      if (!options.force && latest && latest.hash === hash) {
        if (options.advanceWatermark) {
          meta.inferredThroughSeq = Math.max(meta.inferredThroughSeq, options.throughSeq);
          await this.writeMeta(meta);
        }
        const existing = await this.loadSpecUnlocked(latest.id);
        return { version: latest, unchanged: true, spec: existing };
      }

      const id = `v-${stamp()}-${hash.slice(0, 8)}`;
      const spec: OpenApiDocument = {
        ...options.spec,
        info: { ...options.spec.info, version: id, title: options.title },
      };
      const version: VersionInfo = {
        id,
        createdAt: new Date().toISOString(),
        hash,
        exchangeCount: options.exchangeCount,
        sessionIds: [...new Set(options.sessionIds)].sort(),
        operationCount: countOperations(spec.paths),
        title: options.title,
        file: `specs/${id}.json`,
        fromSeq: options.fromSeq,
        throughSeq: options.throughSeq,
        source: options.source,
      };
      await this.atomicWrite(join(this.root, "specs", `${id}.json`), JSON.stringify(spec, null, 2) + "\n");
      index.versions.push(version);
      await this.atomicWrite(this.indexPath(), JSON.stringify(index, null, 2) + "\n");
      if (options.advanceWatermark) {
        meta.inferredThroughSeq = Math.max(meta.inferredThroughSeq, options.throughSeq);
        await this.writeMeta(meta);
      }
      return { version, unchanged: false, spec };
    });
  }

  private async loadSpecUnlocked(id: string): Promise<OpenApiDocument> {
    const raw = await readFile(join(this.root, "specs", `${id}.json`), "utf8");
    return JSON.parse(raw) as OpenApiDocument;
  }
}

export async function openStore(root: string): Promise<RecordingStore> {
  const store = new RecordingStore(root);
  await store.init();
  return store;
}

export function specHash(doc: OpenApiDocument): string {
  return sha256(canonicalize(stripNonContract({ paths: doc.paths })));
}
