// Email plugin (Ray 11-28: "not all have gmail"; agent#746). Any mailbox over IMAP + SMTP, our own code, no
// Composio. The mailbox lives in Pulsar (api.sticks.email.*): the person connects it on their own screen, the
// password stays in Pulsar's password store and never reaches the engine or a Stick.
// A Stick reaches it only through this plugin, as its own Pulsar account, with the person who asked in
// X-Requested-By: Pulsar uses that person's mailbox, and refuses a call nobody asked for (no watching of mail).
// search and read are GET (run free); send is POST, a write, so the owner taps Approve or Decline first.
import { draftFromOpenApi } from "./plugin-builder.js";
import type { DraftRepository } from "./plugin-draft-store.js";

export const EMAIL_PLUGIN_NAME = "email";
export const EMAIL_OPS = ["search", "read", "send"] as const;

export function emailPluginDocument(engineUrl: string): unknown {
  const q = (name: string, type: string, description: string, required = false) => ({ name, in: "query", required, schema: { type }, description });
  return {
    openapi: "3.0.3",
    info: {
      title: "Email (built-in plugin)",
      version: "1.0.0",
      description: "The asking person's own mailbox (any provider, IMAP + SMTP). Read only when asked; sending always asks for approval. The password is never visible.",
    },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/email/search": {
        get: {
          operationId: "email_search",
          summary: "Find recent emails (headers only), newest first",
          parameters: [q("query", "string", "Words to look for"), q("folder", "string", "Folder, default INBOX"), q("limit", "integer", "At most 25"), q("unread_only", "integer", "1 for unread only")],
          responses: { "200": { description: "Matching emails" } },
        },
      },
      "/internal/email/read": {
        get: {
          operationId: "email_read",
          summary: "Read one email by uid (stays unread)",
          parameters: [q("uid", "string", "From email_search", true), q("folder", "string", "Folder, default INBOX")],
          responses: { "200": { description: "The email" } },
        },
      },
      "/internal/email/send": {
        post: {
          operationId: "email_send",
          summary: "Send an email from the person's mailbox",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["to", "subject", "body"],
                  properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, in_reply_to: { type: "string", description: "message_id of the email being answered" } },
                },
              },
            },
          },
          responses: { "200": { description: "Sent" } },
        },
      },
    },
  };
}

/** Seeds the plugin once as a draft; an admin switches it on. */
export async function seedEmailPlugin(repo: DraftRepository, engineUrl: string): Promise<boolean> {
  if (await repo.get(EMAIL_PLUGIN_NAME)) return false;
  await repo.put(draftFromOpenApi(EMAIL_PLUGIN_NAME, emailPluginDocument(engineUrl)));
  return true;
}

const ALLOWED: Record<(typeof EMAIL_OPS)[number], { method: "GET" | "POST"; fields: readonly string[] }> = {
  search: { method: "GET", fields: ["query", "folder", "limit", "unread_only"] },
  read: { method: "GET", fields: ["uid", "folder"] },
  send: { method: "POST", fields: ["to", "subject", "body", "cc", "in_reply_to"] },
};

export class EmailProxyError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 405) {
    super(message);
  }
}

/** Maps one plugin call to the single Pulsar gateway call (one API, with cmd). Only the known fields pass. */
export function emailGatewayRequest(op: string, method: string, q: URLSearchParams, body: Record<string, unknown>): { cmd: string; payload: Record<string, unknown> } {
  const spec = (ALLOWED as Record<string, (typeof ALLOWED)["search"]>)[op];
  if (!spec) throw new EmailProxyError("unknown operation", 404);
  if (method !== spec.method) throw new EmailProxyError(`${op} takes ${spec.method}`, 405);
  const payload: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = spec.method === "GET" ? q.get(f) : body[f];
    if (v !== null && v !== undefined && v !== "") payload[f] = v;
  }
  return { cmd: `api.sticks.email.${op}`, payload };
}

export const GATEWAY_PATH = "/api/v1/method/rokct.platform.api";
