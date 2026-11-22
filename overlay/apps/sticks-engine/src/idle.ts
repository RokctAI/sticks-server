// Idle and next-wake (spec 7.6; brief task 8). The runner reads GET /internal/idle to decide when to stop a
// tenant's container, and the next wake time to start it again. Nothing here polls: the snapshot is computed
// when it is asked for, and pushed when it changes (see the PR for what drives the change).
import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "../../../packages/db/src/index.ts";
import { readSecret, SECRETS_DIR } from "./config.js";

export type IdleInputs = {
  /** Runs leased or running right now. */
  activeRuns: number;
  /** Open client streams. undefined: not tracked yet, so the tenant is not idle (never sleep a busy one). */
  openStreams: number | undefined;
  /** Live background scripts. undefined: not tracked yet, so the tenant is not idle. */
  liveScripts: number | undefined;
  /** The earliest routine's next run and waiting run's wake time after now, or null. */
  nextWakeAt: Date | null;
};

export type IdleSnapshot = { idle: boolean; since: string; next_wake_at: string | null };

/** The §7.6 rule: idle when no leased or running runs, no open streams and no live script. Pure; tested. */
export function isIdle(inputs: IdleInputs): boolean {
  return (
    inputs.activeRuns === 0 &&
    inputs.openStreams === 0 &&
    inputs.liveScripts === 0
  );
}

/** Snapshot, keeping `since` while the idle state is unchanged. Pure; tested. */
export function idleSnapshot(
  previous: { idle: boolean; since: string } | undefined,
  inputs: IdleInputs,
  now: Date,
): IdleSnapshot {
  const idle = isIdle(inputs);
  const since = previous && previous.idle === idle ? previous.since : now.toISOString();
  return { idle, since, next_wake_at: inputs.nextWakeAt ? inputs.nextWakeAt.toISOString() : null };
}

/** Holds the last snapshot and reports whether a new one differs in what the runner cares about. */
export class IdleTracker {
  private last: IdleSnapshot | undefined;

  /** Returns the snapshot, and whether it changed (idle state or next wake) since the last call. */
  update(inputs: IdleInputs, now: Date): { snapshot: IdleSnapshot; changed: boolean } {
    const snapshot = idleSnapshot(this.last, inputs, now);
    const changed =
      this.last === undefined ||
      this.last.idle !== snapshot.idle ||
      this.last.next_wake_at !== snapshot.next_wake_at;
    this.last = snapshot;
    return { snapshot, changed };
  }
}

/** The inputs the database can give: runs and routines. Streams and scripts are passed in by the caller. */
export async function readIdleInputs(
  prisma: PrismaClient,
  now: Date,
  streams: () => number | undefined,
  scripts: () => number | undefined,
  orgId?: string,
): Promise<IdleInputs> {
  // One tenant (idle?site=): only that organization's runs and routines. Streams and scripts are counted for the
  // whole engine (they carry no tenant), so a busy neighbour can delay a tenant's idle but never hide its work.
  const scope = orgId ? { space: { organizationId: orgId } } : {};
  const [activeRuns, nextRoutine, nextWait] = await Promise.all([
    prisma.run.count({ where: { status: { in: ["leased", "running"] }, ...scope } }),
    prisma.routine.findFirst({
      where: { active: true, nextRunAt: { gt: now }, ...scope },
      orderBy: { nextRunAt: "asc" },
      select: { nextRunAt: true },
    }),
    prisma.run.findFirst({
      where: { status: "queued", wakeAt: { gt: now }, ...scope },
      orderBy: { wakeAt: "asc" },
      select: { wakeAt: true },
    }),
  ]);
  const candidates = [nextRoutine?.nextRunAt, nextWait?.wakeAt].filter((d): d is Date => d instanceof Date);
  const nextWakeAt = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  return { activeRuns, openStreams: streams(), liveScripts: scripts(), nextWakeAt };
}

/** The bearer secret for /internal/*: /run/secrets/engine_secret. Missing means every call is refused. */
export function engineSecretFrom(dir: string = SECRETS_DIR): string | undefined {
  try {
    return readSecret("engine_secret", dir);
  } catch {
    return undefined;
  }
}

/** Constant-time check of `Authorization: Bearer <secret>`. Pure; tested. */
export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Pushes a changed snapshot to STICKS_IDLE_PUSH_URL, if set. A failed push is reported, never thrown. */
export async function pushIdle(
  url: string | undefined,
  snapshot: IdleSnapshot,
  secret: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(snapshot),
    });
    return response.ok;
  } catch {
    return false;
  }
}
