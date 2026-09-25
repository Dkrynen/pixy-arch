import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAudioMeter,
  fetchAudioStatus,
  setAudioMute,
  startAudioMeter,
  stopAudioMeter,
  stopAudioMeterKeepalive
} from "../lib/apiClient";
import type { AudioStatus } from "../types/api";
import { useAudio } from "./useAudio";

vi.mock("../lib/apiClient", () => ({
  fetchAudioStatus: vi.fn(),
  fetchAudioMeter: vi.fn(),
  startAudioMeter: vi.fn(),
  stopAudioMeter: vi.fn(),
  stopAudioMeterKeepalive: vi.fn(),
  setAudioMute: vi.fn(),
  setAudioVolume: vi.fn(),
  setAudioDefaultSource: vi.fn(),
  startAudioMonitor: vi.fn(),
  stopAudioMonitor: vi.fn()
}));

const mockedFetchAudioStatus = vi.mocked(fetchAudioStatus);
const mockedSetAudioMute = vi.mocked(setAudioMute);
const mockedFetchAudioMeter = vi.mocked(fetchAudioMeter);
const mockedStartAudioMeter = vi.mocked(startAudioMeter);
const mockedStopAudioMeter = vi.mocked(stopAudioMeter);
const mockedStopAudioMeterKeepalive = vi.mocked(stopAudioMeterKeepalive);

function status(overrides: Partial<AudioStatus> = {}): AudioStatus {
  return {
    available: true,
    card: 0,
    name: "EMEET PIXY",
    muted: true,
    volume: 100,
    source_node: "alsa_input.pixy",
    default_source: false,
    monitor_running: false,
    reason: null,
    ...overrides
  };
}

describe("useAudio", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockedFetchAudioStatus.mockReset();
    mockedSetAudioMute.mockReset();
    mockedFetchAudioMeter.mockReset();
    mockedStartAudioMeter.mockReset();
    mockedStopAudioMeter.mockReset();
    mockedStopAudioMeterKeepalive.mockReset();
  });

  it("stops a running meter with a keepalive request when the page is hidden", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status());
    mockedStartAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, source_node: "alsa_input.pixy", reason: null });
    mockedFetchAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, level: 5, source_node: "alsa_input.pixy", reason: null });

    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Idle meter: leaving the page sends nothing.
    window.dispatchEvent(new Event("pagehide"));
    expect(mockedStopAudioMeterKeepalive).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.setMeterRunning?.(true);
    });
    window.dispatchEvent(new Event("pagehide"));

    expect(mockedStopAudioMeterKeepalive).toHaveBeenCalledTimes(1);
  });

  it("reports whether a command succeeded", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status({ muted: false }));
    mockedSetAudioMute.mockRejectedValueOnce(new Error("amixer failed")).mockResolvedValueOnce({
      ok: true,
      command: "mute",
      value: true,
      card: 0
    });

    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let first: boolean | undefined;
    let second: boolean | undefined;
    await act(async () => {
      first = await result.current.setMuted(true);
    });
    await act(async () => {
      second = await result.current.setMuted(true);
    });

    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it("loads audio status", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status());
    const { result } = renderHook(() => useAudio());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status?.muted).toBe(true);
    expect(result.current.status?.volume).toBe(100);
  });

  it("starts the meter and polls the live level", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status());
    mockedStartAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, source_node: "alsa_input.pixy", reason: null });
    mockedFetchAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, level: 42, source_node: "alsa_input.pixy", reason: null });

    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setMeterRunning?.(true);
    });

    expect(result.current.status?.meter_running).toBe(true);
    expect(mockedStartAudioMeter).toHaveBeenCalled();

    await waitFor(() => expect(result.current.status?.level).toBe(42), { timeout: 3000 });
  });

  it("stops the meter and clears the level", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status());
    mockedStartAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, source_node: "alsa_input.pixy", reason: null });
    mockedStopAudioMeter.mockResolvedValue({ ok: true, running: false, pid: null, source_node: null, reason: null });
    mockedFetchAudioMeter.mockResolvedValue({ ok: true, running: true, pid: 1234, level: 10, source_node: "alsa_input.pixy", reason: null });

    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setMeterRunning?.(true);
    });
    await act(async () => {
      await result.current.setMeterRunning?.(false);
    });

    expect(result.current.status?.meter_running).toBe(false);
    expect(result.current.status?.level).toBeNull();
  });

  it("surfaces an error and rolls back when mute fails", async () => {
    mockedFetchAudioStatus.mockResolvedValue(status({ muted: true }));
    mockedSetAudioMute.mockRejectedValue(new Error("amixer missing"));

    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setMuted(false);
    });

    expect(result.current.status?.muted).toBe(true);
    expect(result.current.error).toBe("amixer missing");
  });
});
