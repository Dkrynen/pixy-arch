import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCommandLogEntries, resetCommandLogForTests } from "../lib/commandLog";
import { useHotplugEvents } from "./useHotplugEvents";

type Listener = (event: Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  listeners = new Map<string, Listener>();
  closed = false;
  readyState = MockEventSource.CONNECTING;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.listeners.get("open")?.(new Event("open"));
  }

  fail(readyState: number = MockEventSource.CONNECTING) {
    this.readyState = readyState;
    this.listeners.get("error")?.(new Event("error"));
  }
}

describe("useHotplugEvents", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    resetCommandLogForTests();
  });

  afterEach(() => {
    MockEventSource.instances = [];
    vi.restoreAllMocks();
    globalThis.EventSource = originalEventSource;
  });

  it("subscribes to backend hotplug events and routes video and HID refreshes", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const onVideo = vi.fn();
    const onHid = vi.fn();

    const { unmount } = renderHook(() => useHotplugEvents({ onVideo, onHid }));
    const source = MockEventSource.instances[0];

    expect(source.url).toBe("/api/hotplug/events");

    act(() => source.open());

    expect(onVideo).toHaveBeenCalledTimes(1);
    expect(onHid).toHaveBeenCalledTimes(1);

    act(() => {
      source.emit("hotplug", {
        action: "add",
        subsystem: "video4linux",
        device_node: "/dev/video0",
        device_type: "video"
      });
      source.emit("hotplug", {
        action: "add",
        subsystem: "hidraw",
        device_node: "/dev/hidraw14",
        device_type: "hid"
      });
    });

    expect(onVideo).toHaveBeenCalledTimes(2);
    expect(onHid).toHaveBeenCalledTimes(2);

    unmount();

    expect(source.closed).toBe(true);
  });

  it("tracks connection state and logs lifecycle events", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const onVideo = vi.fn();
    const onHid = vi.fn();

    const { result } = renderHook(() => useHotplugEvents({ onVideo, onHid }));
    const source = MockEventSource.instances[0];

    expect(result.current.connected).toBe(false);

    act(() => source.open());
    expect(result.current.connected).toBe(true);
    expect(getCommandLogEntries().map((entry) => entry.message)).toContain("event link connected");

    act(() => source.fail(MockEventSource.CONNECTING));
    expect(result.current.connected).toBe(false);
    expect(getCommandLogEntries().map((entry) => entry.message)).toContain("event link lost — retrying");
  });

  it("logs a closed link as an error instead of a retry notice", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    renderHook(() => useHotplugEvents({ onVideo: vi.fn(), onHid: vi.fn() }));
    const source = MockEventSource.instances[0];

    act(() => source.fail(MockEventSource.CLOSED));

    expect(getCommandLogEntries().map((entry) => entry.message)).toContain("event link closed");
  });

  it("logs hotplug events into the command log", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    renderHook(() => useHotplugEvents({ onVideo: vi.fn(), onHid: vi.fn() }));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit("hotplug", {
        action: "remove",
        subsystem: "video4linux",
        device_node: "/dev/video0",
        device_type: "video"
      });
    });

    const entry = getCommandLogEntries().find((item) => item.message.includes("/dev/video0"));
    expect(entry?.message).toBe("video4linux remove /dev/video0");
    expect(entry?.tone).toBe("warn");
  });
});
