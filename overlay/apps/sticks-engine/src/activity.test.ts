import { describe, expect, it } from "vitest";
import { ActivityCounter, countStream } from "./activity.js";

describe("activity counters for idle", () => {
  it("counts tracked work and tells listeners on each change", async () => {
    const c = new ActivityCounter();
    const seen: number[] = [];
    c.onChange(() => seen.push(c.value));
    await c.track(async () => expect(c.value).toBe(1));
    await expect(c.track(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(c.value).toBe(0);
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it("counts an event stream until its body ends, and ignores other responses", async () => {
    const c = new ActivityCounter();
    const plain = countStream(new Response("hi", { headers: { "content-type": "text/plain" } }), c);
    expect(c.value).toBe(0);
    expect(await plain.text()).toBe("hi");
    const sse = countStream(new Response("data: 1\n\n", { headers: { "content-type": "text/event-stream" } }), c);
    expect(c.value).toBe(1);
    expect(await sse.text()).toBe("data: 1\n\n");
    expect(c.value).toBe(0);
  });

  it("stops counting when the client leaves", async () => {
    const c = new ActivityCounter();
    const body = new ReadableStream({ pull() {} });
    const sse = countStream(new Response(body, { headers: { "content-type": "text/event-stream" } }), c);
    expect(c.value).toBe(1);
    await sse.body!.cancel();
    expect(c.value).toBe(0);
  });
});
