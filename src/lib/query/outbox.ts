import { useCallback, useRef, useState } from "react";

export type OutboxItem<TInput> = {
  /** Client-only identifier. Never sent to the server and never treated as a server id. */
  clientId: string;
  input: TInput;
  /**
   * "sent": the server accepted it (`serverId` is its real id). The item is kept, not removed, so
   * the consumer can keep showing the SAME message (now with a "sent" indicator) and match it to the
   * persisted record by `serverId`. Only used when `confirmedId` is provided.
   */
  status: "sending" | "failed" | "sent";
  serverId?: string;
  /** When the user pressed send (ms). Display only. */
  createdAt: number;
  error: string | null;
};

/**
 * An "outbox" for user-authored content (messages, notes). It shows what the user just submitted
 * immediately as a normal message with a "sending" indicator, marks it "sent" (with the server id)
 * when the server confirms, or "failed" with retry/discard. The same item (same clientId) goes through
 * every state, so the UI shows one message throughout.
 *
 * Pending items live here, in component state, NOT in the query cache: the cache only ever holds
 * records the server has accepted, so there are no fake ids or timestamps to reconcile.
 */
export function useOutbox<TInput, TResult = unknown>(
  submit: (input: TInput) => Promise<TResult>,
  confirmedId?: (result: TResult) => string,
): {
  items: OutboxItem<TInput>[];
  send: (input: TInput) => Promise<boolean>;
  retry: (clientId: string) => Promise<boolean>;
  discard: (clientId: string) => void;
} {
  const [items, setItems] = useState<OutboxItem<TInput>[]>([]);
  const counter = useRef(0);

  const run = useCallback(
    async (clientId: string, input: TInput): Promise<boolean> => {
      try {
        const result = await submit(input);
        setItems((current) =>
          confirmedId
            ? current.map((item) =>
                item.clientId === clientId
                  ? { ...item, status: "sent", serverId: confirmedId(result) }
                  : item,
              )
            : current.filter((item) => item.clientId !== clientId),
        );
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not send. Please try again.";
        setItems((current) =>
          current.map((item) =>
            item.clientId === clientId ? { ...item, status: "failed", error: message } : item,
          ),
        );
        return false;
      }
    },
    [submit, confirmedId],
  );

  const send = useCallback(
    (input: TInput) => {
      const clientId = `client-${++counter.current}`;
      setItems((current) => [
        ...current,
        { clientId, input, status: "sending", error: null, createdAt: Date.now() },
      ]);
      return run(clientId, input);
    },
    [run],
  );

  const retry = useCallback(
    (clientId: string) => {
      const target = items.find((item) => item.clientId === clientId);
      // Only a failed item can be retried: a second click or a "sent" item must not post again.
      if (!target || target.status !== "failed") return Promise.resolve(false);
      setItems((current) =>
        current.map((item) =>
          item.clientId === clientId ? { ...item, status: "sending", error: null } : item,
        ),
      );
      return run(clientId, target.input);
    },
    [items, run],
  );

  const discard = useCallback((clientId: string) => {
    setItems((current) => current.filter((item) => item.clientId !== clientId));
  }, []);

  return { items, send, retry, discard };
}
