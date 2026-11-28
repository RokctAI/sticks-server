// The built-in GitHub plugin (brief task 22). The plugin is an OpenAPI description (overlay/plugins/github/),
// the form upstream's "Add your own tools" takes for OpenAPI. These checks are about the description: that it
// loads, which calls are reads, which need approval, and that every call carries the credential.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { connectorToolRequiresApproval } from "../../../packages/core/src/runs/action-approval.ts";

type Operation = { operationId: string; security?: unknown[]; summary?: string };
type Spec = {
  openapi: string;
  servers: { url: string }[];
  security: unknown[];
  paths: Record<string, Record<string, Operation | unknown>>;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

async function loadPlugin(): Promise<{ spec: Spec; manifest: { name: string; $schema: string } }> {
  const spec = JSON.parse(await readFile(new URL("../../../plugins/github/openapi.json", import.meta.url), "utf8")) as Spec;
  const manifest = JSON.parse(await readFile(new URL("../../../plugins/github/plugin.json", import.meta.url), "utf8"));
  return { spec, manifest };
}

function operations(spec: Spec): { method: string; operationId: string; op: Operation }[] {
  const out: { method: string; operationId: string; op: Operation }[] = [];
  for (const item of Object.values(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as Operation | undefined;
      if (op) out.push({ method, operationId: op.operationId, op });
    }
  }
  return out;
}

describe("the built-in GitHub plugin (brief task 22)", () => {
  it("loads: an OpenAPI 3 description and a manifest with the required name and schema", async () => {
    const { spec, manifest } = await loadPlugin();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.servers[0]?.url).toBe("https://api.github.com");
    expect(manifest.name).toBe("github");
    expect(manifest.$schema).toContain("plugin.schema.json");
  });

  it("covers repos, contents, issues and pull requests, with unique operation names", async () => {
    const { spec } = await loadPlugin();
    const ids = operations(spec).map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const wanted of [
      "list_repos",
      "get_repo",
      "read_file",
      "write_file",
      "list_issues",
      "create_issue",
      "get_issue",
      "comment_on_issue",
      "list_pull_requests",
      "create_pull_request",
      "get_pull_request",
      "merge_pull_request",
    ]) {
      expect(ids).toContain(wanted);
    }
  });

  it("reads are the GET operations and run free; every other operation asks for approval", async () => {
    const { spec } = await loadPlugin();
    for (const { method, operationId } of operations(spec)) {
      const readOnly = method === "get";
      expect(connectorToolRequiresApproval(operationId, readOnly), operationId).toBe(!readOnly);
    }
  });

  it("every operation carries the credential, so the call goes out with the user's token", async () => {
    const { spec } = await loadPlugin();
    const globalAuth = spec.security.length > 0;
    for (const { operationId, op } of operations(spec)) {
      const secured = (op.security ?? []).length > 0 || globalAuth;
      expect(secured, operationId).toBe(true);
    }
    expect(JSON.stringify(spec.security)).toContain("githubToken");
  });
});
