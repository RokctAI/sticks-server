// Calls the docker's one Pulsar for one tenant's site (many tenants, step 2). Pulsar picks the site from the Host
// header only, and Node's fetch replaces a custom Host with the URL's host, so this uses node:http(s) directly:
// the connection goes to the docker's Pulsar address and Host names the tenant's site.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type SiteFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

/** A fetch-like call that sends `Host: site` when a site is given; plain fetch otherwise. */
export function fetchForSite(site: string | undefined, timeoutMs = 30_000): SiteFetch {
  if (!site) return (url, init) => fetch(url, init);
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const send = u.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        {
          host: u.hostname,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method: init.method ?? "GET",
          headers: { ...(init.headers ?? {}), host: site },
          ...(u.protocol === "https:" ? { servername: u.hostname } : {}),
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: { "content-type": String(res.headers["content-type"] ?? "application/json") } })),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("Pulsar did not answer in time")));
      req.on("error", reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
