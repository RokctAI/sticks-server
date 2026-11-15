import { describe, expect, it } from "vitest";
import { callGateForStored, sqlDraftRepository, type SqlQuery } from "./plugin-draft-store.js";
import { seedBuiltinPlugin } from "./plugin-seed.js";
import type { DraftPlugin } from "./plugin-builder.js";

function memoryQuery(): SqlQuery {
  const rows = new Map<string, DraftPlugin>();
  return async (text, values = []) => {
    if (text.startsWith("SELECT body")) {
      const hit = rows.get(String(values[0]));
      return hit ? [{ body: hit }] : [];
    }
    if (text.startsWith("INSERT INTO plugin_draft")) {
      rows.set(String(values[0]), JSON.parse(String(values[2])) as DraftPlugin);
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  };
}

const spec = {
  openapi: "3.0.0",
  info: { title: "GitHub" },
  servers: [{ url: "https://api.github.com" }],
  paths: {
    "/repos/{owner}/{repo}": { get: { operationId: "get_repo" } },
    "/repos/{owner}/{repo}/issues": { post: { operationId: "create_issue" } },
  },
};

describe("seeding the built-in plugin (follow-up to #41)", () => {
  it("a missing built-in plugin is stored as approved, so its reads run from the start", async () => {
    const repo = sqlDraftRepository(memoryQuery());
    expect(await seedBuiltinPlugin(repo, "github", spec)).toBe("seeded");
    expect((await repo.get("github"))?.status).toBe("approved");
    expect(await callGateForStored(repo, "github", "get_repo")).toBe("run");
    expect(await callGateForStored(repo, "github", "create_issue")).toBe("ask");
  });

  it("a restart does not overwrite a plugin that is already stored", async () => {
    const repo = sqlDraftRepository(memoryQuery());
    await seedBuiltinPlugin(repo, "github", spec);
    const changed = { ...spec, info: { title: "Changed by a later release" } };
    expect(await seedBuiltinPlugin(repo, "github", changed)).toBe("present");
    expect((await repo.get("github"))?.title).toBe("GitHub");
  });

  it("a description that is not usable is refused and nothing is stored", async () => {
    const repo = sqlDraftRepository(memoryQuery());
    await expect(seedBuiltinPlugin(repo, "github", { openapi: "2.0" })).rejects.toThrow("OpenAPI 3");
    expect(await repo.get("github")).toBeUndefined();
  });
});
