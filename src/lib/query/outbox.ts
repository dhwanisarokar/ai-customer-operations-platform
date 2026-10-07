import { useCallback, useRef, useState } from "react";

export type OutboxItem<TInput> = {
  /** Client-only identifier. Never sent to the server and never treated as a server id. */
  clientId: string;
  input: TInput;
  status: "sending" | "failed";
  error: string | null;
};

/**
 * An "outbox" for user-authored content (messages, notes). It shows what the user just submitted
 * immediately, as "sending", then removes it once the server confirms (the real server record then
 * appears from the query cache), or keeps it as "failed" with retry/discard.
 *
 * Pending items live here, in component state, NOT in the query cache: the cache only ever holds
 * records the server has accepted, so there are no fake ids or timestamps to reconcile.
 */
export function useOutbox<TInput>(submit: (input: TInput) => Promise<unknown>): {
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
        await submit(input);
        setItems((current) => current.filter((item) => item.clientId !== clientId));
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
    [submit],
  );

  const send = useCallback(
    (input: TInput) => {
      const clientId = `client-${++counter.current}`;
      setItems((current) => [...current, { clientId, input, status: "sending", error: null }]);
      return run(clientId, input);
    },
    [run],
  );

  const retry = useCallback(
    (clientId: string) => {
      const target = items.find((item) => item.clientId === clientId);
      if (!target) return Promise.resolve(false);
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
