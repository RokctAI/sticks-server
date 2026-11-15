// The memory job driver's recovery (spec 7.6 "Boot pass"; brief task 7).
//
// The engine runs its jobs in memory (WAKEUP_DRIVER=memory), so a restart loses queued jobs. This
// module rebuilds them from the database: once on every start, before serving, and again only when
// the one timer fires. Nothing polls. Every re-enqueue uses the job's replace key, so a repeat is
// harmless.
import type { JobPublisher } from "../../../packages/adapter-kit/src/index.ts";
import { routineWakeupJob, runContinueJob } from "../../../packages/adapter-kit/src/index.ts";
import type { PrismaClient } from "../../../packages/db/src/index.ts";

/** Rows per category per pass. The next pass (or the timer) picks up the rest. */
export const BOOT_PASS_BATCH = 500;
/** setTimeout holds at most 2^31-1 ms; a later due item is reached by re-arming. */
export const MAX_TIMER_MS = 2_147_483_647;
/** If a pass fails, the one timer is re-armed this far ahead rather than dropped. */
export const RETRY_AFTER_FAILURE_MS = 30_000;

export type BootPassResult = {
  /** Runs whose lease had expired (a crash in the middle of a run). */
  leasesRecovered: number;
  /** Queued runs that are due now (no wake time, or a wake time that has passed). */
  queuedRecovered: number;
  /** Active routines whose next run is due now. */
  routinesDue: number;
  /** The nearest later item (a lease expiry, a wake time or a routine), or null when none is pending. */
  nextDueAt: Date | null;
};

/** The earliest of the given times that is set, or null. Pure; tested. */
export function earliest(times: ReadonlyArray<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const time of times) {
    if (time && (best === null || time.getTime() < best.getTime())) best = time;
  }
  return best;
}

/** How long the one timer waits for `at`, clamped to what setTimeout accepts. Pure; tested. */
export function timerDelay(now: Date, at: Date): number {
  return Math.min(Math.max(at.getTime() - now.getTime(), 0), MAX_TIMER_MS);
}

type BootDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now?: () => Date;
};

/**
 * One recovery pass: re-enqueue what is due now, and return the nearest later item for the timer.
 *
 * - runs in leased or running whose lease expired: a crash in the middle of a run;
 * - queued runs with no wake time, or a wake time that has passed: queued work that a restart lost;
 * - active routines whose next run has come: a routine that was due while the process was down.
 *
 * The keep-going pass and the credit settlement pass (spec 7.6 items 4 and 5) are not here yet: they
 * need the keep-going table (task 14) and the Pulsar settlement (task 12). They join this pass then.
 */
export async function bootPass(deps: BootDeps): Promise<BootPassResult> {
  const now = deps.now ? deps.now() : new Date();
  const { prisma, jobs } = deps;

  const expired = await prisma.run.findMany({
    where: { status: { in: ["leased", "running"] }, leaseExpiresAt: { lte: now } },
    select: { id: true },
    take: BOOT_PASS_BATCH,
  });
  for (const run of expired) await jobs.enqueue(runContinueJob(run.id));

  const queued = await prisma.run.findMany({
    where: { status: "queued", OR: [{ wakeAt: null }, { wakeAt: { lte: now } }] },
    select: { id: true },
    take: BOOT_PASS_BATCH,
  });
  for (const run of queued) await jobs.enqueue(runContinueJob(run.id));

  const routines = await prisma.routine.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    select: { id: true, nextRunAt: true },
    take: BOOT_PASS_BATCH,
  });
  for (const routine of routines) {
    if (routine.nextRunAt) await jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt));
  }

  const [nextWake, nextLease, nextRoutine] = await Promise.all([
    prisma.run.findFirst({
      where: { status: "queued", wakeAt: { gt: now } },
      orderBy: { wakeAt: "asc" },
      select: { wakeAt: true },
    }),
    prisma.run.findFirst({
      where: { status: { in: ["leased", "running"] }, leaseExpiresAt: { gt: now } },
      orderBy: { leaseExpiresAt: "asc" },
      select: { leaseExpiresAt: true },
    }),
    prisma.routine.findFirst({
      where: { active: true, nextRunAt: { gt: now } },
      orderBy: { nextRunAt: "asc" },
      select: { nextRunAt: true },
    }),
  ]);

  return {
    leasesRecovered: expired.length,
    queuedRecovered: queued.length,
    routinesDue: routines.length,
    nextDueAt: earliest([nextWake?.wakeAt, nextLease?.leaseExpiresAt, nextRoutine?.nextRunAt]),
  };
}

export type BootScheduler = {
  /** Resolves after the first pass has run and its timer is armed. */
  ready: Promise<BootPassResult>;
  /** Clears the one timer. Safe to call twice. */
  stop(): void;
};

/**
 * Runs the boot pass now, then holds exactly one timer for the nearest due item. When the timer
 * fires, it runs the pass again and re-arms. A failed pass re-arms after RETRY_AFTER_FAILURE_MS.
 */
export function startBootScheduler(deps: BootDeps & { onError?: (error: unknown) => void }): BootScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const clock = deps.now ?? (() => new Date());

  const arm = (at: Date | null) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped || !at) return;
    timer = setTimeout(() => void run(), timerDelay(clock(), at));
    timer.unref?.();
  };

  const run = async (): Promise<BootPassResult | undefined> => {
    if (stopped) return undefined;
    try {
      const result = await bootPass(deps);
      arm(result.nextDueAt);
      return result;
    } catch (error) {
      deps.onError?.(error);
      if (!stopped) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void run(), RETRY_AFTER_FAILURE_MS);
        timer.unref?.();
      }
      return undefined;
    }
  };

  return {
    ready: run().then((result) => {
      if (!result) throw new Error("the boot pass failed; see onError");
      return result;
    }),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
