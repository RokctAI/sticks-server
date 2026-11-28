import { describe, expect, it } from "vitest";
import { cleanEntries, readCatalog, saveCatalog } from "./app-catalog.js";

function db() {
  let row: unknown;
  return async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith("INSERT")) { row = { entries: JSON.parse(p[0] as string), version: p[1] }; return []; }
    return row ? [row] : [];
  };
}

describe("app catalog", () => {
  it("is empty until the hub pushes a list", async () => {
    expect(await readCatalog(db())).toEqual({ entries: [], version: "" });
  });
  it("keeps only display fields; secrets and junk never get stored", async () => {
    const q = db();
    const saved = await saveCatalog(q, { version: "7", entries: [
      { id: "google", name: "Google", summary: "Mail and calendar", can: ["Read your mail"], client_secret: "x", token: "y" },
      { id: "Bad Id", name: "x", summary: "y" },
      { id: "google", name: "dup", summary: "dup" },
      { id: "nosummary", name: "n" },
      { id: "logo", name: "L", summary: "s", logo: "http://insecure/x.png" },
    ] });
    expect(saved.entries.map((e) => e.id)).toEqual(["google", "logo"]);
    expect(JSON.stringify(await readCatalog(q))).not.toMatch(/secret|token/);
    expect(saved.entries[1]?.logo).toBeUndefined();
  });
  it("a new push replaces the old list", async () => {
    const q = db();
    await saveCatalog(q, { entries: [{ id: "a", name: "A", summary: "s" }] });
    await saveCatalog(q, { entries: [] });
    expect((await readCatalog(q)).entries).toEqual([]);
  });
  it("ignores non-arrays", () => { expect(cleanEntries("x")).toEqual([]); });
});
