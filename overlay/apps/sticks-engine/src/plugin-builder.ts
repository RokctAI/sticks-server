// The plugin builder (brief task 21; owner's ruling 11-15). A Stick turns a service's OpenAPI description into a
// DRAFT plugin: a connector description with each operation classified, read or write. A draft is never
// callable until a tenant admin approves it (task 20's approval path). Credentials are entered by the admin,
// never seen by the model.
//
// This module is the pure part: the conversion, the name rule and the call gate. Registering the built-in
// skill and storing drafts are not here yet (BLOCKED, see the PR).
import { connectorToolRequiresApproval } from "../../../packages/core/src/action-approval.ts";

/** The plugin name rule from upstream's docs/build-a-plugin.md: 1-64 lowercase letters, digits, dots or hyphens;
 * starts and ends with a letter or digit; no "--" and no "..". */
export const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export type DraftOperation = {
  operationId: string;
  method: string;
  path: string;
  readOnly: boolean;
  /** A write always asks; upstream's rule (task 20). */
  requiresApproval: boolean;
};

export type DraftPlugin = {
  name: string;
  status: "draft" | "approved";
  title: string;
  /** The baseline server URL from the description. Never a credential. */
  serverUrl: string;
  operations: DraftOperation[];
  /** Always true: the admin enters the credential; the model never sees it. */
  credentialEnteredByAdmin: true;
};

const METHODS = ["get", "put", "post", "patch", "delete"] as const;

/** Builds a draft from an OpenAPI 3 document. Refuses anything that is not a usable description. */
export function draftFromOpenApi(name: string, document: unknown): DraftPlugin {
  if (!PLUGIN_NAME.test(name) || name.includes("--") || name.includes("..")) {
    throw new Error("the plugin name must be lowercase letters, digits, dots or hyphens, and start and end with a letter or digit");
  }
  const doc = document as {
    openapi?: unknown;
    info?: { title?: unknown };
    servers?: { url?: unknown }[];
    paths?: Record<string, Record<string, unknown>>;
  } | null;
  if (!doc || typeof doc !== "object" || typeof doc.openapi !== "string" || !/^3\./.test(doc.openapi)) {
    throw new Error("the description must be an OpenAPI 3 document");
  }
  const serverUrl = doc.servers?.[0]?.url;
  if (typeof serverUrl !== "string" || !/^https:\/\//.test(serverUrl)) {
    throw new Error("the description must name an https server");
  }
  const operations: DraftOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method] as { operationId?: unknown } | undefined;
      if (!op) continue;
      const operationId = typeof op.operationId === "string" ? op.operationId : `${method}_${path}`;
      if (seen.has(operationId)) throw new Error(`operation names must be unique: ${operationId}`);
      seen.add(operationId);
      const readOnly = method === "get";
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        readOnly,
        requiresApproval: connectorToolRequiresApproval(operationId, readOnly),
      });
    }
  }
  if (operations.length === 0) throw new Error("the description has no operations");
  const title = typeof doc.info?.title === "string" ? doc.info.title : name;
  return { name, status: "draft", title, serverUrl, operations, credentialEnteredByAdmin: true };
}

/** Approves a draft. Only an admin may; the caller says whether the actor is one (the admin check is upstream's). */
export function approveDraft(draft: DraftPlugin, actorIsAdmin: boolean): DraftPlugin {
  if (!actorIsAdmin) throw new Error("only a tenant admin can approve a plugin");
  return { ...draft, status: "approved" };
}

/**
 * Whether an operation may be called at all. A draft is never callable. An approved plugin's reads run free;
 * its writes still go through the per-call approval (upstream's rule), so this returns "ask" for them.
 */
export function callGate(draft: DraftPlugin, operationId: string): "refuse" | "run" | "ask" {
  if (draft.status !== "approved") return "refuse";
  const op = draft.operations.find((candidate) => candidate.operationId === operationId);
  if (!op) return "refuse";
  return op.requiresApproval ? "ask" : "run";
}
