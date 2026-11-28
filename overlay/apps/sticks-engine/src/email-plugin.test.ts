import { describe, expect, it } from "vitest";
import { draftFromOpenApi } from "./plugin-builder.js";
import { emailGatewayRequest, emailPluginDocument, EmailProxyError, seedEmailPlugin } from "./email-plugin.js";

describe("email plugin", () => {
  it("reads run free and send asks", () => {
    const d = draftFromOpenApi("email", emailPluginDocument("https://e.example"));
    expect(d.status).toBe("draft");
    expect(d.operations.map((o) => o.method).sort()).toEqual(["GET", "GET", "POST"]);
  });

  it("seeds once as a draft", async () => {
    const store = new Map<string, unknown>();
    const repo = { get: async (n: string) => store.get(n) as never, put: async (p: { name: string }) => void store.set(p.name, p) } as never;
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(true);
    expect(await seedEmailPlugin(repo, "https://e.example")).toBe(false);
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
