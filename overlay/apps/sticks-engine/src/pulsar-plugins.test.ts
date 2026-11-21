import { describe, expect, it } from "vitest";
import { draftFromOpenApi } from "./plugin-builder.js";
import { areaPluginDocument, PULSAR_AREAS, pulsarRequest, seedPulsarPlugins, PulsarProxyError } from "./pulsar-plugins.js";

describe("Pulsar plugins", () => {
  it("makes one plugin per area with reads free and writes asking", () => {
    const d = draftFromOpenApi("pulsar-crm", areaPluginDocument("crm", "https://e.example"));
    expect(d.status).toBe("draft");
    expect(d.operations.map((o) => o.method).sort()).toEqual(["GET", "GET", "POST", "POST", "POST"]);
  });

  it("seeds every area once, as drafts", async () => {
    const store = new Map<string, unknown>();
    const repo = { get: async (n: string) => store.get(n) as never, put: async (p: { name: string }) => void store.set(p.name, p) } as never;
    expect(await seedPulsarPlugins(repo, "https://e.example")).toHaveLength(Object.keys(PULSAR_AREAS).length);
    expect(await seedPulsarPlugins(repo, "https://e.example")).toHaveLength(0);
  });

  it("maps calls to Pulsar and refuses record types outside the area", () => {
    expect(pulsarRequest("crm", "get", new URLSearchParams({ doctype: "Lead", name: "L 1" }), {}).path).toBe("/api/resource/Lead/L%201");
    expect(pulsarRequest("crm", "update", new URLSearchParams(), { doctype: "Contact", name: "C1", fields: { a: 1 } })).toEqual({ method: "PUT", path: "/api/resource/Contact/C1", body: { a: 1 } });
    expect(pulsarRequest("crm", "find", new URLSearchParams({ doctype: "Lead", limit: "500" }), {}).path).toContain("limit_page_length=100");
    expect(() => pulsarRequest("crm", "get", new URLSearchParams({ doctype: "Salary Slip", name: "x" }), {})).toThrow(PulsarProxyError);
    expect(() => pulsarRequest("crm", "find", new URLSearchParams({ doctype: "Lead", filters: "{bad" }), {})).toThrow("JSON");
  });
});
