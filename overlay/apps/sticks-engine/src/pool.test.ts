import { describe, expect, it } from "vitest";
import { createDb, createPool } from "../../../packages/db/src/database/client.ts";

const DB_URL = "postgres://engine:engine@127.0.0.1:9/engine";

describe("pool idle timeout option (patch 0001)", () => {
  it("keeps upstream's default: idle clients are never closed", async () => {
    const pool = createPool(DB_URL);
    expect(pool.options.idleTimeoutMillis).toBe(0);
    await pool.end();
  });

  it("reaches the pool when the engine asks for 30 s", async () => {
    const pool = createPool(DB_URL, { idleTimeoutMillis: 30_000 });
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
    await pool.end();
  });

  it("reaches the pool through createDb, which the API uses", async () => {
    const { pool } = createDb(DB_URL, { idleTimeoutMillis: 30_000, encryptContent: false });
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
    await pool.end();
  });
});
