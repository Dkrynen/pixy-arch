import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAudioMeter,
  fetchAudioStatus,
  setAudioMute,
  startAudioMeter,
  stopAudioMeter
} from "../lib/apiClient";
import type { AudioStatus } from "../types/api";
import { useAudio } from "./useAudio";

vi.mock("../lib/apiClient", () => ({
  fetchAudioStatus: vi.fn(),
  fetchAudioMeter: vi.fn(),
  startAudioMeter: vi.fn(),
  stopAudioMeter: vi.fn(),
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
