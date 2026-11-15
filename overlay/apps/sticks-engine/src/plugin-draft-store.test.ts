import { describe, expect, it } from "vitest";
import { draftFromOpenApi, type DraftPlugin } from "./plugin-builder.js";
import {
  ADMIN_ROLE,
  approveStoredDraft,
  callGateForStored,
  ensurePluginDraftTable,
  PLUGIN_DRAFT_TABLE_SQL,
  saveDraft,
  sqlDraftRepository,
  type SqlQuery,
} from "./plugin-draft-store.js";

/** A fake of the one call the repository makes, backed by a map. Recognises the three statements it sends. */
function fakeQuery() {
  const rows = new Map<string, { body: DraftPlugin }>();
  const statements: string[] = [];
  const query: SqlQuery = async (text, values = []) => {
    statements.push(text);
    if (text.startsWith("CREATE TABLE IF NOT EXISTS plugin_draft")) return [];
    if (text.startsWith("SELECT body FROM plugin_draft")) {
      const hit = rows.get(String(values[0]));
      return hit ? [{ body: hit.body }] : [];
    }
    if (text.startsWith("INSERT INTO plugin_draft")) {
      const body = JSON.parse(String(values[2])) as DraftPlugin;
      rows.set(String(values[0]), { body });
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  return { query, statements };
}

const spec = {
  openapi: "3.0.0",
  info: { title: "Weather" },
  servers: [{ url: "https://api.weather.example" }],
  paths: {
    "/forecast": { get: { operationId: "get_forecast" } },
    "/alerts": { post: { operationId: "create_alert" } },
  },
};

describe("the plugin draft table (follow-up to #42)", () => {
  it("is created with IF NOT EXISTS, so it is safe on every start", async () => {
    const fake = fakeQuery();
    await ensurePluginDraftTable(fake.query);
    expect(fake.statements).toEqual([PLUGIN_DRAFT_TABLE_SQL]);
    expect(PLUGIN_DRAFT_TABLE_SQL.startsWith("CREATE TABLE IF NOT EXISTS plugin_draft")).toBe(true);
  });

  it("a saved draft is read back as the same draft", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    const draft = draftFromOpenApi("weather", spec);
    await saveDraft(repo, draft);
    expect(await repo.get("weather")).toEqual(draft);
  });

  it("a name that is not a plugin name is refused before any SQL runs", async () => {
    const fake = fakeQuery();
    const repo = sqlDraftRepository(fake.query);
    await expect(repo.get("Bad Name")).rejects.toThrow("not a plugin name");
    await expect(repo.get("a..b")).rejects.toThrow("not a plugin name");
    expect(fake.statements).toEqual([]);
  });
});

describe("approval and the call gate (brief task 21, settled rule: Sticks Admin)", () => {
  it("a draft cannot be called: the gate refuses every operation", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    await saveDraft(repo, draftFromOpenApi("weather", spec));
    expect(await callGateForStored(repo, "weather", "get_forecast")).toBe("refuse");
    expect(await callGateForStored(repo, "weather", "create_alert")).toBe("refuse");
  });

  it("a Sticks Member cannot approve, and the draft stays a draft", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    await saveDraft(repo, draftFromOpenApi("weather", spec));
    await expect(approveStoredDraft(repo, "weather", "Sticks Member")).rejects.toThrow("only a Sticks Admin");
    expect((await repo.get("weather"))?.status).toBe("draft");
  });

  it("a Sticks Admin approves; reads then run and writes ask (upstream name rule: get_/list_ etc. as words)", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    await saveDraft(repo, draftFromOpenApi("weather", spec));
    await approveStoredDraft(repo, "weather", ADMIN_ROLE);
    expect(await callGateForStored(repo, "weather", "get_forecast")).toBe("run");
    expect(await callGateForStored(repo, "weather", "create_alert")).toBe("ask");
    expect(await callGateForStored(repo, "weather", "noSuchOperation")).toBe("refuse");
  });

  it("saving a draft again resets it: the changed description must be approved again", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    await saveDraft(repo, draftFromOpenApi("weather", spec));
    await approveStoredDraft(repo, "weather", ADMIN_ROLE);
    await saveDraft(repo, draftFromOpenApi("weather", spec));
    expect((await repo.get("weather"))?.status).toBe("draft");
    expect(await callGateForStored(repo, "weather", "get_forecast")).toBe("refuse");
  });

  it("approving a plugin that was never saved is refused", async () => {
    const repo = sqlDraftRepository(fakeQuery().query);
    await expect(approveStoredDraft(repo, "missing", ADMIN_ROLE)).rejects.toThrow("no draft named missing");
  });
});
