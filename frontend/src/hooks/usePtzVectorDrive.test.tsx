import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PtzVector } from "../types/api";
import {
  PTZ_STOP_RETRY_DELAYS_MS,
  PTZ_VECTOR_HEARTBEAT_MS,
  PTZ_VECTOR_MIN_INTERVAL_MS,
  usePtzVectorDrive
} from "./usePtzVectorDrive";

const STOP = { x: 0, y: 0, z: 0 };

function isStop(vector: PtzVector) {
  return vector.x === 0 && vector.y === 0;
}

describe("usePtzVectorDrive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends the held vector every 500 ms and stops the heartbeat on release", async () => {
    const send = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: 6, y: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PTZ_VECTOR_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PTZ_VECTOR_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([vector]) => vector.x === 6)).toBe(true);

    await expect(result.current.stop()).resolves.toBe(true);
    expect(send).toHaveBeenLastCalledWith(STOP);

    await vi.advanceTimersByTimeAsync(PTZ_VECTOR_HEARTBEAT_MS * 4);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("orders the stop after a vector request that is still in flight", async () => {
    let finishVector!: (ok: boolean) => void;
    const send = vi.fn((vector: PtzVector) =>
      isStop(vector)
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            finishVector = resolve;
          })
    );
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    void result.current.move({ x: 0, y: 8 });
    const stopped = result.current.stop();
    await vi.advanceTimersByTimeAsync(50);

    // The zero vector must not overtake the vector still on the wire.
    expect(send).toHaveBeenCalledTimes(1);

    finishVector(true);
    await expect(stopped).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(STOP);
  });

  it("retries a failed stop with backoff until the device accepts it", async () => {
    const stopResults = [false, false, true];
    const send = vi.fn(async (vector: PtzVector) => (isStop(vector) ? stopResults.shift() ?? true : true));
    const onStopped = vi.fn();
    const { result } = renderHook(() => usePtzVectorDrive(send, { onStopped, sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: -4, y: 0 });
    const stopped = result.current.stop();
    await vi.advanceTimersByTimeAsync(PTZ_STOP_RETRY_DELAYS_MS[0] + PTZ_STOP_RETRY_DELAYS_MS[1]);

    await expect(stopped).resolves.toBe(true);
    expect(send.mock.calls.filter(([vector]) => isStop(vector))).toHaveLength(3);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("gives up after three retries and reports the stop as failed", async () => {
    const send = vi.fn(async (vector: PtzVector) => !isStop(vector));
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: 3, y: 3 });
    const stopped = result.current.stop();
    await vi.advanceTimersByTimeAsync(PTZ_STOP_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0));

    await expect(stopped).resolves.toBe(false);
    expect(send.mock.calls.filter(([vector]) => isStop(vector))).toHaveLength(1 + PTZ_STOP_RETRY_DELAYS_MS.length);
  });

  it("treats a rejected send as a failed stop and retries", async () => {
    let stopAttempts = 0;
    const send = vi.fn(async (vector: PtzVector) => {
      if (isStop(vector)) {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          throw new Error("HID busy");
        }
      }
      return true;
    });
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: 2, y: 0 });
    const stopped = result.current.stop();
    await vi.advanceTimersByTimeAsync(PTZ_STOP_RETRY_DELAYS_MS[0]);

    await expect(stopped).resolves.toBe(true);
    expect(stopAttempts).toBe(2);
  });

  it.each([
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
    [
      "hidden visibility",
      () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    ]
  ])("sends a keepalive stop on %s while moving", async (_label, trigger) => {
    const send = vi.fn().mockResolvedValue(true);
    const sendKeepaliveStop = vi.fn();
    const onHalt = vi.fn();
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop, onHalt }));

    await result.current.move({ x: 6, y: 0 });
    trigger();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    expect(sendKeepaliveStop).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(result.current.isMoving()).toBe(false);

    // The heartbeat is gone, so the gimbal is not re-armed after the stop.
    await vi.advanceTimersByTimeAsync(PTZ_VECTOR_HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores page-exit events while idle", () => {
    const sendKeepaliveStop = vi.fn();
    renderHook(() => usePtzVectorDrive(vi.fn().mockResolvedValue(true), { sendKeepaliveStop }));

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("blur"));

    expect(sendKeepaliveStop).not.toHaveBeenCalled();
  });

  it("stops motion when the component unmounts", async () => {
    const send = vi.fn().mockResolvedValue(true);
    const { result, unmount } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: 0, y: -6 });
    unmount();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenLastCalledWith(STOP);
    await vi.advanceTimersByTimeAsync(PTZ_VECTOR_HEARTBEAT_MS * 2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("abandons a pending stop retry when new motion starts", async () => {
    const send = vi.fn(async (vector: PtzVector) => !isStop(vector));
    const { result } = renderHook(() => usePtzVectorDrive(send, { sendKeepaliveStop: vi.fn() }));

    await result.current.move({ x: 5, y: 0 });
    const stopped = result.current.stop();
    await vi.advanceTimersByTimeAsync(0);
    await result.current.move({ x: -5, y: 0 });
    await vi.advanceTimersByTimeAsync(PTZ_STOP_RETRY_DELAYS_MS[0] + PTZ_VECTOR_MIN_INTERVAL_MS);

    await expect(stopped).resolves.toBe(false);
    expect(send.mock.calls.filter(([vector]) => isStop(vector))).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith({ x: -5, y: 0 });
    expect(result.current.isMoving()).toBe(true);
  });
});
