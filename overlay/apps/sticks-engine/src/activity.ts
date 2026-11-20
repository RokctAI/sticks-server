// Live activity the database cannot show (brief task 8 follow-up): open streams and running sandbox commands.
// The front door counts streaming responses (text/event-stream) until their body ends or the client leaves;
// the helper client counts each command it is waiting on. Every change calls the listeners, so the engine
// re-checks idle and pushes a change to Pulsar at once, with no polling.
export class ActivityCounter {
  private n = 0;
  private readonly listeners = new Set<() => void>();

  get value(): number {
    return this.n;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Counts one piece of work; the returned function ends it (calling it twice ends it once). */
  begin(): () => void {
    this.n += 1;
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.n -= 1;
      this.emit();
    };
  }

  /** Counts the work while the promise is pending. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const end = this.begin();
    try {
      return await work();
    } finally {
      end();
    }
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // A listener's failure never breaks the counted work.
      }
    }
  }
}

export const openStreams = new ActivityCounter();
export const liveScripts = new ActivityCounter();

/** Counts a streaming response until its body is done or cancelled. Other responses pass through unchanged. */
export function countStream(response: Response, counter: ActivityCounter = openStreams): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !type.includes("text/event-stream")) return response;
  const end = counter.begin();
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
