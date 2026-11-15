// A small node:http listener for a Fetch-style app (Hono's app.fetch). This folder has no package.json,
// so it does not depend on @hono/node-server; the conversion is the standard Node one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * What the Node side hands to app.fetch as its environment. Hono's getConnInfo (used by upstream's
 * client-IP resolver) reads the socket from `incoming`, exactly as @hono/node-server does.
 */
export type NodeEnv = { incoming: IncomingMessage; outgoing: ServerResponse };
export type FetchApp = { fetch: (request: Request, env: NodeEnv) => Response | Promise<Response> };

export function toRequest(req: IncomingMessage): Request {
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

/** Resolves on drain, or when the client has gone (so a dead socket never blocks the loop). */
function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Copies the body to the socket, one chunk at a time, honouring backpressure. If the client
 * disconnects mid-stream, the body is cancelled and reading stops, so the app's stream (a model
 * reply, a long poll) does not keep producing into nothing.
 */
export async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
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

  const reader = response.body.getReader();
  let gone = false;
  const onClose = () => {
    if (res.writableFinished) return;
    gone = true;
    void reader.cancel().catch(() => undefined);
  };
  res.once("close", onClose);
  try {
    while (!gone) {
      const { done, value } = await reader.read();
      if (done || gone) break;
      if (!res.write(value)) await waitForDrain(res);
    }
    if (!gone) res.end();
  } catch {
    // The app's stream failed mid-body: the status is already sent, so end the response.
    if (!gone) res.end();
  } finally {
    res.off("close", onClose);
  }
}

/** Listens on host:port and hands each request to app.fetch. Returns the Node server. */
export function serveFetch(app: FetchApp, port: number, host: string): Server {
  const server = createServer(async (req, res) => {
    try {
      const response = await app.fetch(toRequest(req), { incoming: req, outgoing: res });
      await writeResponse(response, res);
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
  server.listen(port, host);
  return server;
}
