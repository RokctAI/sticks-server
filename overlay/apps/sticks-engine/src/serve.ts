// A small node:http listener for a Fetch-style app (Hono's app.fetch). This folder has no package.json,
// so it does not depend on @hono/node-server; the conversion is the standard Node one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type FetchApp = { fetch: (request: Request) => Response | Promise<Response> };

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as never).pipe(res);
}

/** Listens on host:port and hands each request to app.fetch. Returns the Node server. */
export function serveFetch(app: FetchApp, port: number, host: string): Server {
  const server = createServer(async (req, res) => {
    try {
      await writeResponse(await app.fetch(toRequest(req)), res);
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
  server.listen(port, host);
  return server;
}
