import { describe, expect, it } from "vitest";
import { approveDraft, callGate, draftFromOpenApi, PLUGIN_NAME } from "./plugin-builder.js";

/** A small OpenAPI description, the kind a service publishes. */
const SAMPLE = {
  openapi: "3.0.3",
  info: { title: "Invoices API" },
  servers: [{ url: "https://api.invoices.example/v1" }],
  paths: {
    "/invoices": {
      get: { operationId: "list_invoices", responses: { "200": { description: "ok" } } },
      post: { operationId: "create_invoice", responses: { "201": { description: "ok" } } },
    },
    "/invoices/{id}": {
      get: { operationId: "get_invoice", responses: { "200": { description: "ok" } } },
      delete: { operationId: "delete_invoice", responses: { "204": { description: "ok" } } },
    },
  },
};

describe("the plugin name rule (upstream's docs/build-a-plugin.md)", () => {
  it("accepts plain names and refuses the rest", () => {
    expect(PLUGIN_NAME.test("invoices")).toBe(true);
    expect(PLUGIN_NAME.test("my-app.v2")).toBe(true);
    expect(PLUGIN_NAME.test("-leading")).toBe(false);
    expect(PLUGIN_NAME.test("Upper")).toBe(false);
    expect(PLUGIN_NAME.test("a".repeat(65))).toBe(false);
    expect(() => draftFromOpenApi("bad--name", SAMPLE)).toThrow("lowercase");
    expect(() => draftFromOpenApi("bad..name", SAMPLE)).toThrow("lowercase");
  });
});

describe("a sample OpenAPI file becomes a draft plugin (brief task 21)", () => {
  it("is a draft, with every operation classified: reads free, writes asking", () => {
    const draft = draftFromOpenApi("invoices", SAMPLE);
    expect(draft.status).toBe("draft");
    expect(draft.title).toBe("Invoices API");
    expect(draft.serverUrl).toBe("https://api.invoices.example/v1");
    expect(draft.credentialEnteredByAdmin).toBe(true);
    const byId = Object.fromEntries(draft.operations.map((op) => [op.operationId, op]));
    expect(byId.list_invoices).toMatchObject({ readOnly: true, requiresApproval: false, method: "GET" });
    expect(byId.get_invoice).toMatchObject({ readOnly: true, requiresApproval: false });
    expect(byId.create_invoice).toMatchObject({ readOnly: false, requiresApproval: true, method: "POST" });
    expect(byId.delete_invoice).toMatchObject({ readOnly: false, requiresApproval: true, method: "DELETE" });
  });

  it("no credential is in the draft", () => {
    const text = JSON.stringify(draftFromOpenApi("invoices", { ...SAMPLE, components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Key" } } } }));
    expect(text).not.toMatch(/secret|token|apiKey=/i);
  });

  it("refuses a description that is not usable", () => {
    expect(() => draftFromOpenApi("x1", { openapi: "2.0", servers: [{ url: "https://a" }], paths: {} })).toThrow("OpenAPI 3");
    expect(() => draftFromOpenApi("x1", { ...SAMPLE, servers: [{ url: "http://insecure" }] })).toThrow("https");
    expect(() => draftFromOpenApi("x1", { ...SAMPLE, paths: {} })).toThrow("no operations");
    const dup = { ...SAMPLE, paths: { "/a": { get: { operationId: "same", responses: {} } }, "/b": { get: { operationId: "same", responses: {} } } } };
    expect(() => draftFromOpenApi("x1", dup)).toThrow("unique");
  });
});

describe("a draft cannot be called before approval (brief task 21)", () => {
  const draft = draftFromOpenApi("invoices", SAMPLE);

  it("a draft refuses every call, reads included", () => {
    expect(callGate(draft, "list_invoices")).toBe("refuse");
    expect(callGate(draft, "create_invoice")).toBe("refuse");
  });

  it("only a tenant admin can approve it", () => {
    expect(() => approveDraft(draft, false)).toThrow("admin");
  });

  it("once approved, reads run and writes ask for approval", () => {
    const live = approveDraft(draft, true);
    expect(live.status).toBe("approved");
    expect(callGate(live, "list_invoices")).toBe("run");
    expect(callGate(live, "create_invoice")).toBe("ask");
    expect(callGate(live, "not_an_operation")).toBe("refuse");
  });
});
