// The Pulsar plugin documents and the call mapping, with no imports, so the live check can load this file
// directly with Node (type stripping) and test exactly what the engine serves.

/** Areas and their record types. New areas are added here; everything else is generated. */
export const PULSAR_AREAS: Readonly<Record<string, { title: string; doctypes: readonly string[] }>> = {
  crm: { title: "CRM", doctypes: ["Lead", "Opportunity", "Prospect", "Contact", "Customer", "Appointment", "Campaign", "Contract"] },
  selling: { title: "Selling", doctypes: ["Quotation", "Sales Order", "Customer"] },
  accounts: { title: "Accounts", doctypes: ["Sales Invoice", "Purchase Invoice", "Payment Entry"] },
  stock: { title: "Stock", doctypes: ["Item", "Stock Entry", "Delivery Note", "Purchase Receipt"] },
  hr: { title: "HR", doctypes: ["Employee", "Leave Application", "Attendance"] },
  projects: { title: "Projects", doctypes: ["Project", "Task", "Timesheet"] },
};

export const OPS = ["find", "get", "create", "update", "submit"] as const;
export type Op = (typeof OPS)[number];

export function pluginName(area: string): string {
  return `pulsar-${area}`;
}

/** The OpenAPI document for one area. `find` and `get` are GET (read-only); the rest are POST (ask approval). */
export function areaPluginDocument(area: string, engineUrl: string): unknown {
  const a = PULSAR_AREAS[area];
  if (!a) throw new Error(`unknown Pulsar area: ${area}`);
  const doctype = { name: "doctype", in: "query", required: true, schema: { type: "string", enum: [...a.doctypes] } };
  const nameParam = { name: "name", in: "query", required: true, schema: { type: "string" } };
  const body = (props: Record<string, unknown>, required: string[]) => ({
    required: true,
    content: { "application/json": { schema: { type: "object", required, properties: props } } },
  });
  const base = `/internal/pulsar/${area}`;
  return {
    openapi: "3.0.3",
    info: { title: `Pulsar ${a.title}`, version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      [`${base}/find`]: {
        get: {
          operationId: `${area}_find`,
          summary: `Find ${a.title} records (${a.doctypes.join(", ")}) with optional filters`,
          parameters: [doctype, { name: "filters", in: "query", schema: { type: "string", description: "JSON list of [field, op, value]" } }, { name: "limit", in: "query", schema: { type: "integer" } }],
          responses: { "200": { description: "Matching records" } },
        },
      },
      [`${base}/get`]: { get: { operationId: `${area}_get`, summary: `Read one ${a.title} record`, parameters: [doctype, nameParam], responses: { "200": { description: "The record" } } } },
      [`${base}/create`]: {
        post: { operationId: `${area}_create`, summary: `Create a ${a.title} record`, requestBody: body({ doctype: doctype.schema, fields: { type: "object" } }, ["doctype", "fields"]), responses: { "200": { description: "The new record" } } },
      },
      [`${base}/update`]: {
        post: { operationId: `${area}_update`, summary: `Update a ${a.title} record`, requestBody: body({ doctype: doctype.schema, name: { type: "string" }, fields: { type: "object" } }, ["doctype", "name", "fields"]), responses: { "200": { description: "The record" } } },
      },
      [`${base}/submit`]: {
        post: { operationId: `${area}_submit`, summary: `Submit a ${a.title} draft`, requestBody: body({ doctype: doctype.schema, name: { type: "string" } }, ["doctype", "name"]), responses: { "200": { description: "The record" } } },
      },
    },
  };
}

/**
 * Areas whose plugin has passed its live check (a real model calls it against a real Pulsar; Ray 11-21: each
 * plugin needs a test, except the GitHub plugin). Only these are seeded for an admin to switch on. An area is
 * added here only with the run that proved it, named in docs/tasks/pulsar-plugins.md.
 */
export const TESTED_AREAS: readonly string[] = [];

export class PulsarProxyError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) {
    super(message);
  }
}

/** Maps one plugin call to a Pulsar /api/resource request. Refuses record types outside the area. */
export function pulsarRequest(area: string, op: string, q: URLSearchParams, body: Record<string, unknown>): { method: string; path: string; body?: unknown } {
  const a = PULSAR_AREAS[area];
  if (!a) throw new PulsarProxyError("unknown area", 404);
  if (!(OPS as readonly string[]).includes(op)) throw new PulsarProxyError("unknown operation", 404);
  const doctype = String((op === "find" || op === "get" ? q.get("doctype") : body.doctype) ?? "");
  if (!a.doctypes.includes(doctype)) throw new PulsarProxyError(`${doctype || "that record type"} is not in ${a.title}`, 403);
  const dt = encodeURIComponent(doctype);
  const name = String((op === "get" ? q.get("name") : body.name) ?? "");
  if ((op === "get" || op === "update" || op === "submit") && !name) throw new PulsarProxyError("name is required", 400);
  const nm = encodeURIComponent(name);
  switch (op as Op) {
    case "find": {
      const p = new URLSearchParams({ fields: JSON.stringify(["*"]), limit_page_length: String(Math.min(Number(q.get("limit") ?? 20) || 20, 100)) });
      const f = q.get("filters");
      if (f) {
        try {
          JSON.parse(f);
        } catch {
          throw new PulsarProxyError("filters must be JSON", 400);
        }
        p.set("filters", f);
      }
      return { method: "GET", path: `/api/resource/${dt}?${p}` };
    }
    case "get":
      return { method: "GET", path: `/api/resource/${dt}/${nm}` };
    case "create":
      return { method: "POST", path: `/api/resource/${dt}`, body: body.fields ?? {} };
    case "update":
      return { method: "PUT", path: `/api/resource/${dt}/${nm}`, body: body.fields ?? {} };
    case "submit":
      return { method: "POST", path: `/api/resource/${dt}/${nm}/submit` };
  }
}
