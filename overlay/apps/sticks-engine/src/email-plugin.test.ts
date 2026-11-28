import { describe, expect, it } from "vitest";
import { draftFromOpenApi } from "./plugin-builder.js";
import { emailGatewayRequest, emailPluginDocument, EmailProxyError, seedEmailPlugin } from "./email-plugin.js";

describe("email plugin", () => {
  it("reads run free and send asks", () => {
    const d = draftFromOpenApi("email", emailPluginDocument("https://e.example"));
    expect(d.status).toBe("draft");
    expect(d.operations.map((o) => o.method).sort()).toEqual(["GET", "GET", "GET", "GET", "POST", "POST", "POST"]);
  });

  it("seeds once as a draft", async () => {
    const store = new Map<string, unknown>();
    const repo = { get: async (n: string) => store.get(n) as never, put: async (p: { name: string }) => void store.set(p.name, p) } as never;
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(true);
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(false);
  });

  it("refreshes an older stored copy and keeps it approved", async () => {
    const store = new Map<string, { name: string; status: string; operations: unknown[] }>();
    store.set("email", { name: "email", status: "approved", operations: [1, 2, 3] });
    const repo = { get: async (n: string) => store.get(n) as never, put: async (p: { name: string }) => void store.set(p.name, p as never) } as never;
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(true);
    expect(store.get("email")!.status).toBe("approved");
    expect(store.get("email")!.operations).toHaveLength(7);
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(false);
  });

  it("move and unsubscribe are writes", () => {
    expect(emailGatewayRequest("move", "POST", new URLSearchParams(), { uids: ["1"], to_folder: "Archive", x: 1 })).toEqual({ cmd: "api.sticks.email.move", payload: { uids: ["1"], to_folder: "Archive" } });
    expect(() => emailGatewayRequest("unsubscribe", "GET", new URLSearchParams({ uid: "1" }), {})).toThrow(EmailProxyError);
  });

  it("maps to the one gateway cmd and passes only known fields", () => {
    expect(emailGatewayRequest("search", "GET", new URLSearchParams({ query: "invoice", password: "x" }), {})).toEqual({ cmd: "api.sticks.email.search", payload: { query: "invoice" } });
    expect(emailGatewayRequest("send", "POST", new URLSearchParams(), { to: "a@b.co", subject: "Hi", body: "B", email_address: "x" }).payload).toEqual({ to: "a@b.co", subject: "Hi", body: "B" });
  });

  it("refuses connect, disconnect and a send by GET", () => {
    expect(() => emailGatewayRequest("connect", "POST", new URLSearchParams(), {})).toThrow(EmailProxyError);
    expect(() => emailGatewayRequest("disconnect", "POST", new URLSearchParams(), {})).toThrow(EmailProxyError);
    expect(() => emailGatewayRequest("send", "GET", new URLSearchParams({ to: "a@b.co" }), {})).toThrow(EmailProxyError);
  });
});
