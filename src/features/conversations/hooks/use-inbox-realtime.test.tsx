// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationsKeys } from "@/lib/query/query-keys";
import { renderHookWithQuery, TEST_ORG } from "../../../../tests/helpers/query";
import { useInboxRealtime } from "./use-inbox-realtime";

type Listener = (event: Event) => void;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("useInboxRealtime", () => {
  it("opens one stream with no client-chosen channel, refetches on events and reconnects", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { client, unmount } = renderHookWithQuery(() => useInboxRealtime());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/realtime/inbox");

    source.emit("ready"); // first connection: queries are already loading
    expect(invalidate).not.toHaveBeenCalled();
    source.emit("message.created");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationsKeys.all(TEST_ORG) });
    invalidate.mockClear();
    source.emit("ready"); // reconnect: reconcile what was missed
    expect(invalidate).toHaveBeenCalledTimes(1);

    unmount();
    expect(source.closed).toBe(true);
  });
});
