import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * Tiny bookstore API with two contract generations.
 *   node examples/upstream.mjs --port 4000 --version 1
 */
export function startUpstream({ port = 0, host = "127.0.0.1", version = 1 } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };
    const book = (id) => {
      const title = id === 1 ? "Kindred" : id === 2 ? "Dawn" : "Parable";
      if (version === 1) return { id, title, author: "Butler", price: 14 + id * 2, inStock: true };
      return { id, title, author: "Butler", price: (14 + id * 2).toFixed(2), currency: "USD" };
    };

    if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
      send(200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && parts.length === 1 && parts[0] === "books") {
      send(200, { books: [book(1), book(2)] });
      return;
    }
    if (req.method === "POST" && parts.length === 1 && parts[0] === "books") {
      if (version >= 2 && !payload?.isbn) {
        send(400, { error: "isbn_required" });
        return;
      }
      const created = { ...book(3), title: payload?.title ?? "Parable", ...(version >= 2 ? { isbn: payload?.isbn } : {}) };
      send(201, created);
      return;
    }
    if (parts[0] === "books" && parts[1] && parts.length === 2 && req.method === "GET") {
      const id = Number(parts[1]);
      if (!Number.isInteger(id)) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, book(id));
      return;
    }
    if (parts[0] === "books" && parts[2] === "reviews" && req.method === "GET") {
      send(200, {
        reviews: [version === 1 ? { id: 9, rating: 5, body: "essential" } : { id: 9, body: "essential" }],
      });
      return;
    }
    if (parts[0] === "books" && parts[2] === "related" && req.method === "GET") {
      if (version < 2) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, { books: [book(1)] });
      return;
    }
    if (parts[0] === "authors" && parts[1] && req.method === "GET") {
      if (version >= 2) {
        send(404, { error: "gone" });
        return;
      }
      send(200, { id: Number(parts[1]), name: "Butler", email: "octavia@example.com" });
      return;
    }
    send(404, { error: "not_found", path: url.pathname });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP port"));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        version,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const invoked = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invoked) {
  const port = Number(arg("port", "4000"));
  const version = Number(arg("version", "1"));
  const upstream = await startUpstream({ port, version });
  console.log(`upstream ${upstream.url} version=${version}`);
  process.on("SIGINT", () => {
    upstream.close().finally(() => process.exit(0));
  });
}
