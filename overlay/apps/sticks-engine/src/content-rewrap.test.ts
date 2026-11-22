import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
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
