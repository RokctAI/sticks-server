// The sandbox self-test (spec 8.1; brief task 15). Run as user `sticks`. It only checks: it tries to reach
// the addresses a sandboxed command must not reach, and exits non-zero if any connection succeeds. The
// firewall rules are installed by the runner, not here.
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

export type Target = { label: string; host: string; port: number };

/** The targets: loopback, the container's own address, the Postgres address, and the private ranges. */
export function selftestTargets(input: { postgresHost: string; postgresPort: number; ownAddress?: string }): Target[] {
  const own = input.ownAddress ?? firstOwnIPv4() ?? "127.0.0.2";
  return [
    { label: "loopback", host: "127.0.0.1", port: 80 },
    { label: "the container's own address", host: own, port: 80 },
    { label: "the Postgres address", host: input.postgresHost, port: input.postgresPort },
    { label: "10.0.0.0/8", host: "10.0.0.1", port: 80 },
    { label: "172.16.0.0/12", host: "172.16.0.1", port: 80 },
    { label: "192.168.0.0/16", host: "192.168.0.1", port: 80 },
    { label: "169.254.169.254 (metadata)", host: "169.254.169.254", port: 80 },
  ];
}

/** The first non-loopback IPv4 address of this machine, if any. */
export function firstOwnIPv4(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

/** True when a TCP connection to the target opens within the timeout. */
export function probe(target: Target, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const done = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Probes every target. Returns the ones that connected; any entry here is a failure. */
export async function runSelftest(
  targets: Target[],
  check: (target: Target) => Promise<boolean> = (target) => probe(target),
): Promise<{ reached: Target[]; exitCode: 0 | 1 }> {
  const reached: Target[] = [];
  for (const target of targets) {
    if (await check(target)) reached.push(target);
  }
  return { reached, exitCode: reached.length === 0 ? 0 : 1 };
}
