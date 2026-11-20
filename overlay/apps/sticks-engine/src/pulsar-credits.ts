// Credits from Pulsar (brief task 12, spec 6 and 5.3 rows 2-3). A run spends from a block that Pulsar reserves:
// - run start: reserve(run, stick, user). A refusal means the run does not start, with Pulsar's reason;
// - each model call: the call's maximum cost comes off the block in memory, with no network call;
// - below 20 percent of the block: extend(run). A refusal is upstream's "credits exhausted" error;
// - run end: settle(run, used_micros, usage), idempotent on the run id;
// - boot: settle again every run that was not settled (a crash between the last call and settle).
// Units are micro-dollars; 10,000 make one credit (1 credit = 1 US cent).
import { request } from "node:http";
import type { SqlQuery } from "./plugin-draft-store.js";

export const MICROS_PER_CREDIT = 10_000;
export const EXTEND_BELOW = 0.2;

export const CREDIT_RUNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_credit_runs (
  run_id text PRIMARY KEY,
  block_micros bigint NOT NULL,
  used_micros bigint NOT NULL DEFAULT 0,
  usage jsonb,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

export class CreditsRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number; [k: string]: unknown };

/** The three Pulsar calls. Each answers {ok: true, block_micros?} or {ok: false, reason}. */
export interface CreditsTransport {
  call(path: "/credits/reserve" | "/credits/extend" | "/credits/settle", body: Record<string, unknown>): Promise<{ ok: boolean; block_micros?: number | undefined; reason?: string | undefined }>;
}

/** HTTP over the unix socket in STICKS_PULSAR_SOCKET, with the per-tenant engine secret. */
export function socketTransport(socketPath: string, secret: string, timeoutMs = 10_000): CreditsTransport {
  return {
    call: (path, body) =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request(
          {
            socketPath,
            path,
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": Buffer.byteLength(payload) },
            timeout: timeoutMs,
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (text += c));
            res.on("end", () => {
              try {
                const parsed = JSON.parse(text) as { ok?: boolean; block_micros?: number; reason?: string };
                if (res.statusCode && res.statusCode >= 500) return reject(new Error(`pulsar answered HTTP ${res.statusCode}`));
                resolve({ ok: parsed.ok === true, block_micros: parsed.block_micros, reason: parsed.reason });
              } catch {
                reject(new Error(`pulsar answered HTTP ${res.statusCode} without JSON`));
              }
            });
          },
        );
        req.on("timeout", () => req.destroy(new Error("pulsar credits call timed out")));
        req.on("error", reject);
        req.end(payload);
      }),
  };
}

/** Converts a dollar bound to micro-dollars, rounding up. Unknown cost counts as one credit, so a call is never free. */
export function microsOf(maxCostUsd: number | undefined): number {
  if (maxCostUsd === undefined || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) return MICROS_PER_CREDIT;
  return Math.ceil(maxCostUsd * 1_000_000);
}

/** One run's block. Shaped like upstream's ModelCallObserver (beforeCall/afterCall) so it can stand in for it. */
export class RunCredits {
  private remaining: number;
  private used = 0;
  private extending: Promise<void> | undefined;
  private usage: Usage = {};
  private settled = false;

  private constructor(
    private readonly t: CreditsTransport,
    private readonly query: SqlQuery,
    readonly runId: string,
    private block: number,
  ) {
    this.remaining = block;
  }

  /** Reserves a block for the run. Throws CreditsRefused with Pulsar's reason when it says no. */
  static async start(t: CreditsTransport, query: SqlQuery, run: { runId: string; stickId: string; userId: string }): Promise<RunCredits> {
    const r = await t.call("/credits/reserve", { run: run.runId, stick: run.stickId, user: run.userId });
    if (!r.ok || !r.block_micros) throw new CreditsRefused(r.reason ?? "credits refused");
    await query(CREDIT_RUNS_TABLE_SQL, []);
    await query(`INSERT INTO sticks_credit_runs (run_id, block_micros) VALUES ($1, $2) ON CONFLICT (run_id) DO NOTHING`, [run.runId, r.block_micros]);
    return new RunCredits(t, query, run.runId, r.block_micros);
  }

  /** Takes the call's maximum cost off the block. Asks Pulsar for more below 20 percent; a refusal throws. */
  async beforeCall(call: { maxCostUsd?: number; callId?: string }): Promise<string> {
    const cost = microsOf(call.maxCostUsd);
    if (this.remaining - cost < this.block * EXTEND_BELOW) await this.extend();
    if (this.remaining < cost) throw new CreditsRefused("credits exhausted");
    this.remaining -= cost;
    this.used += cost;
    return call.callId ?? `${this.runId}:${this.used}`;
  }

  /** Records what the call really used. The block keeps the maximum; settle reports the real total. */
  async afterCall(_reservationId: string, usage: Usage | null): Promise<void> {
    if (!usage) return;
    for (const [k, v] of Object.entries(usage)) if (typeof v === "number") this.usage[k] = ((this.usage[k] as number) ?? 0) + v;
    await this.query(`UPDATE sticks_credit_runs SET used_micros = $2, usage = $3::jsonb WHERE run_id = $1`, [this.runId, this.usedMicros(), JSON.stringify(this.usage)]);
  }

  /** Real use when the provider reported a cost, else the maxima taken off the block. */
  usedMicros(): number {
    return typeof this.usage.costUsd === "number" ? Math.ceil(this.usage.costUsd * 1_000_000) : this.used;
  }

  private extend(): Promise<void> {
    this.extending ??= (async () => {
      try {
        const r = await this.t.call("/credits/extend", { run: this.runId });
        if (!r.ok || !r.block_micros) throw new CreditsRefused(r.reason ?? "credits exhausted");
        this.remaining += r.block_micros;
        this.block = r.block_micros;
        await this.query(`UPDATE sticks_credit_runs SET block_micros = block_micros + $2 WHERE run_id = $1`, [this.runId, r.block_micros]);
      } finally {
        this.extending = undefined;
      }
    })();
    return this.extending;
  }

  /** Ends the run. Safe to call twice: the second call does nothing, and Pulsar dedupes on the run id. */
  async settle(): Promise<void> {
    if (this.settled) return;
    await settleRun(this.t, this.query, this.runId, this.usedMicros(), this.usage);
    this.settled = true;
  }
}

async function settleRun(t: CreditsTransport, query: SqlQuery, runId: string, used: number, usage: unknown): Promise<void> {
  const r = await t.call("/credits/settle", { run: runId, used_micros: used, usage });
  if (!r.ok) throw new Error(`settle refused: ${r.reason ?? "no reason"}`);
  await query(`UPDATE sticks_credit_runs SET settled_at = now() WHERE run_id = $1`, [runId]);
}

/** Boot pass: settles every run left unsettled by a crash. Returns how many were settled; failures stay for next boot. */
export async function settleLeftovers(t: CreditsTransport, query: SqlQuery): Promise<number> {
  await query(CREDIT_RUNS_TABLE_SQL, []);
  const rows = (await query(`SELECT run_id, used_micros, usage FROM sticks_credit_runs WHERE settled_at IS NULL`, [])) as Array<{
    run_id: string;
    used_micros: string | number;
    usage: unknown;
  }>;
  let n = 0;
  for (const row of rows) {
    try {
      await settleRun(t, query, row.run_id, Number(row.used_micros), row.usage ?? {});
      n += 1;
    } catch {
      // Left for the next boot pass.
    }
  }
  return n;
}
