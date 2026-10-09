import { subscribeRealtime } from "./publisher";

const HEARTBEAT_MS = 20_000;

/**
 * A Server-Sent Events response for ONE channel the caller was already authorized for. Streams
 * `ready` once, then the channel's events, with a heartbeat comment so proxies keep the connection
 * open. Events are not replayed: a client that reconnects refetches from the API (the database is
 * the source of truth), which is why `ready` doubles as "you are connected, reconcile now".
 */
export function sseResponse(request: Request, channel: string): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      write("retry: 3000\n\n");
      write("event: ready\ndata: {}\n\n");

      const unsubscribe = subscribeRealtime(channel, (event) => {
        write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        cleanup = () => {};
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
