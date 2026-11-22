import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, masterKeysFromEnv } from "../../../packages/db/src/content-keys.ts";
import {
  masterKeyFromContentKey,
  rewrapForMove,
  rewrapFromMove,
  unwrapDataKey,
  wrapDataKey,
  MOVE_KEY_ID,
} from "./content-rewrap.js";

// Made at run time so no fixture looks like a stored secret.
const source = randomBytes(24).toString("hex");
const target = randomBytes(24).toString("hex");
const move = randomBytes(24).toString("hex");

describe("space keys re-wrapped for a docker move", () => {
  const dataKey = randomBytes(32);
  const row = { id: "k1", spaceId: "sA", version: 1, masterKeyId: "env", wrappedKey: wrapDataKey(dataKey, masterKeyFromContentKey(source), "sA", 1) };

  it("source key → move key → target key keeps the same data key", () => {
    const inFile = rewrapForMove(row, source, move);
    expect(inFile.masterKeyId).toBe(MOVE_KEY_ID);
    expect(inFile.wrappedKey).not.toBe(row.wrappedKey);
    const landed = rewrapFromMove(inFile, target, move);
    expect(landed.masterKeyId).toBe("env");
    expect(unwrapDataKey(landed.wrappedKey, masterKeyFromContentKey(target), "sA", 1).equals(dataKey)).toBe(true);
  });

  it("the source key cannot open the landed key, and the file's key needs the move key", () => {
    const inFile = rewrapForMove(row, source, move);
    const landed = rewrapFromMove(inFile, target, move);
    expect(() => unwrapDataKey(landed.wrappedKey, masterKeyFromContentKey(source), "sA", 1)).toThrow();
    expect(() => rewrapFromMove(inFile, target, randomBytes(24).toString("hex"))).toThrow();
  });

  it("a key bound to one space cannot be replayed onto another", () => {
    const inFile = rewrapForMove(row, source, move);
    expect(() => rewrapFromMove({ ...inFile, spaceId: "sB" }, target, move)).toThrow();
  });

  it("refuses a key wrapped by another master key instead of moving it unreadable", () => {
    expect(() => rewrapForMove({ ...row, masterKeyId: "kms1" }, source, move)).toThrow(/only "env"/);
  });

  it("leaves rows that were not wrapped for a move as they are", () => {
    expect(rewrapFromMove(row, target, move)).toEqual(row);
  });
});

// Upstream's own key provider (the one the engine runs), so a byte off in salt, info, AAD or layout fails here.
describe("same format as upstream's content keys", () => {
  const upstream = (contentKey: string) => new LocalKeyProvider(masterKeysFromEnv({ ENCRYPTION_KEY: contentKey } as NodeJS.ProcessEnv));
  const ctx = { spaceId: "space-1", version: 3 };

  it("a key wrapped by upstream opens with our unwrap, and a moved key opens with upstream on the target", async () => {
    const dataKey = randomBytes(32);
    const w = await upstream(source).wrap(dataKey, ctx);
    expect(w.masterKeyId).toBe("env");
    expect(unwrapDataKey(w.wrappedKey, masterKeyFromContentKey(source), ctx.spaceId, ctx.version).equals(dataKey)).toBe(true);
    const row = { id: "k", ...ctx, masterKeyId: w.masterKeyId, wrappedKey: w.wrappedKey };
    const landed = rewrapFromMove(rewrapForMove(row, source, move), target, move);
    const opened = await upstream(target).unwrap({ masterKeyId: landed.masterKeyId, wrappedKey: landed.wrappedKey }, ctx);
    expect(Buffer.from(opened).equals(dataKey)).toBe(true);
    await expect(upstream(source).unwrap({ masterKeyId: landed.masterKeyId, wrappedKey: landed.wrappedKey }, ctx)).rejects.toThrow();
  });

  it("our wrap opens with upstream's provider", async () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, masterKeyFromContentKey(target), ctx.spaceId, ctx.version);
    const opened = await upstream(target).unwrap({ masterKeyId: "env", wrappedKey: wrapped }, ctx);
    expect(Buffer.from(opened).equals(dataKey)).toBe(true);
  });
});
