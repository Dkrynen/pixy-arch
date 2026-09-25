import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSettings, updateSettings } from "../lib/apiClient";
import type { AppSettings } from "../types/api";
import type { UseAudioResult } from "./useAudio";
import type { UsePixyHidResult } from "./usePixyHid";
import { usePrivacySafety } from "./usePrivacySafety";

vi.mock("../lib/apiClient", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn()
}));

const mockedFetchSettings = vi.mocked(fetchSettings);
const mockedUpdateSettings = vi.mocked(updateSettings);

function makeSettings(startInPrivacy: boolean): AppSettings {
  return {
    safety: { start_in_privacy: startInPrivacy },
    server: { host: "127.0.0.1", port: 8000, reload: false, url: "http://127.0.0.1:8000" },
    frontend: {
      dist_path: "/home/user/pixy-arch/frontend/dist",
      dev_server_host: "127.0.0.1",
      dev_server_port: 5173,
      single_port: true
    },
    storage: {
      presets_path: "/home/user/pixy-arch/config/presets.yaml",
      recordings_dir: "/home/user/pixy-arch/recordings"
    },
    hid: { path: null, report_gap_ms: 25 },
    virtualcam: {
      device: null,
      label: "Pixy Arch Virtual",
      autostart: true,
      on_demand: true,
      idle_grace_seconds: 8
    },
    config: { path: "/home/user/pixy-arch/config/pixypilot.yaml" }
  };
}

function makePixyHid(overrides: Partial<UsePixyHidResult> = {}): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw14",
      readable: true,
      writable: true,
      reason: null,
      known_controls: ["tracking", "privacy"]
    },
    isLoading: false,
    pendingCommand: null,
    error: null,
    lastCommand: null,
    trackingMode: null,
    deviceTrackingState: "unknown",
    deviceTrackingRawValue: null,
    deviceTrackingRawBits: [],
    targetTrackingMode: null,
    targetTrackingRawValue: null,
    gestureEnabled: null,
    autoRotateEnabled: null,
    mirrorMode: null,
    focusMeteringMode: null,
    focusMeteringPoint: null,
    audioMode: null,
    autoPrivacySeconds: null,
    refresh: vi.fn(),
    refreshStatus: vi.fn(),
    setTrackingMode: vi.fn().mockResolvedValue(true),
    setTargetTrackingMode: vi.fn(),
    setGestureEnabled: vi.fn(),
    setAutoRotateEnabled: vi.fn(),
    setMirrorMode: vi.fn(),
    setFocusMeteringMode: vi.fn(),
    setAudioMode: vi.fn(),
    setAutoPrivacySeconds: vi.fn(),
    sendPtzDirection: vi.fn(),
    sendPtzRelative: vi.fn(),
    sendPtzAbsolute: vi.fn(),
    sendPtzVector: vi.fn(),
    recenterPtz: vi.fn(),
    savePtzPreset: vi.fn(),
    loadPtzPreset: vi.fn(),
    clearPtzPreset: vi.fn(),
    capturePowerOnDefault: vi.fn(),
    disablePowerOnDefault: vi.fn(),
    goToDefault: vi.fn(),
    setDenoise: vi.fn(),
    setWbLock: vi.fn(),
    setEvLock: vi.fn(),
    setFocusLock: vi.fn(),
    setRemotePairing: vi.fn(),
    setMotorSpeed: vi.fn(),
    ...overrides
  };
}

function makeAudio(overrides: Partial<UseAudioResult> = {}): UseAudioResult {
  return {
    status: {
      available: true,
      card: 3,
      name: "EMEET PIXY",
      muted: false,
      volume: 10,
      source_node: null,
      default_source: null,
      monitor_running: false,
      reason: null
    },
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    setMuted: vi.fn().mockResolvedValue(true),
    setVolume: vi.fn(),
    setDefaultSource: vi.fn(),
    setMonitorRunning: vi.fn(),
    setMeterRunning: vi.fn(),
    restoreDefaultSource: vi.fn(),
    ...overrides
  };
}

describe("usePrivacySafety", () => {
  beforeEach(() => {
    mockedFetchSettings.mockReset();
    mockedUpdateSettings.mockReset();
  });

  it("never closes the lens or mutes the mic on page load, even with startup privacy on", async () => {
    // The backend applies startup privacy when the service boots; reloading
    // the deck mid-call must not re-park the camera.
    mockedFetchSettings.mockResolvedValue(makeSettings(true));
    const pixyHid = makePixyHid();
    const audio = makeAudio();

    const { result, rerender } = renderHook(() => usePrivacySafety(pixyHid, audio));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    rerender();

    expect(pixyHid.setTrackingMode).not.toHaveBeenCalled();
    expect(audio.setMuted).not.toHaveBeenCalled();
    expect(result.current.startupPrivacyEnabled).toBe(true);
    expect(result.current.startupPrivacyState).toBe("enabled");
    expect(result.current.privacyCommandState).toBe("idle");
  });

  it("reports startup privacy as disabled when the setting is off", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const { result } = renderHook(() => usePrivacySafety(makePixyHid(), makeAudio()));

    expect(result.current.startupPrivacyState).toBe("loading");
    await waitFor(() => expect(result.current.startupPrivacyState).toBe("disabled"));
    expect(result.current.startupPrivacyEnabled).toBe(false);
  });

  it("reports startup privacy as unknown when settings cannot be loaded", async () => {
    mockedFetchSettings.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = renderHook(() => usePrivacySafety(makePixyHid(), makeAudio()));

    await waitFor(() => expect(result.current.startupPrivacyState).toBe("unknown"));
    expect(result.current.settingsError).toBe("Failed to fetch");
  });

  it("sends camera privacy and mic mute when entering privacy", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const pixyHid = makePixyHid();
    const audio = makeAudio();

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.enterPrivacy();
    });

    expect(ok).toBe(true);
    expect(pixyHid.setTrackingMode).toHaveBeenCalledWith("privacy");
    expect(audio.setMuted).toHaveBeenCalledWith(true);
    expect(result.current.privacyCommandState).toBe("applied");
  });

  it("reports privacy as sending until the command finishes", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    let finishPrivacy!: (ok: boolean) => void;
    const setTrackingMode = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPrivacy = resolve;
        })
    );
    const pixyHid = makePixyHid({ setTrackingMode });
    const audio = makeAudio();

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.enterPrivacy();
    });
    expect(result.current.privacyCommandState).toBe("sending");

    await act(async () => {
      finishPrivacy(true);
      await pending;
    });

    expect(result.current.privacyCommandState).toBe("applied");
  });

  it("reports a failed privacy command instead of success, but still mutes the mic", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const pixyHid = makePixyHid({ setTrackingMode: vi.fn().mockResolvedValue(false) });
    const audio = makeAudio();

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.enterPrivacy();
    });

    expect(ok).toBe(false);
    expect(audio.setMuted).toHaveBeenCalledWith(true);
    expect(result.current.privacyCommandState).toBe("failed");
  });

  it("reports a failed mic mute separately from camera privacy", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const pixyHid = makePixyHid();
    const audio = makeAudio({ setMuted: vi.fn().mockResolvedValue(false) });

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.enterPrivacy();
    });

    expect(ok).toBe(false);
    expect(result.current.privacyCommandState).toBe("mic-failed");
  });

  it("clears the privacy result once the camera leaves privacy", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const audio = makeAudio();
    let pixyHid = makePixyHid({ trackingMode: "privacy" });

    const { result, rerender } = renderHook(() => usePrivacySafety(pixyHid, audio));

    await act(async () => {
      await result.current.enterPrivacy();
    });
    expect(result.current.privacyCommandState).toBe("applied");

    pixyHid = makePixyHid({ trackingMode: "off" });
    rerender();

    expect(result.current.privacyCommandState).toBe("idle");
  });

  it("leaves privacy without unmuting the mic", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    const pixyHid = makePixyHid();
    const audio = makeAudio();

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.leavePrivacy();
    });

    expect(ok).toBe(true);
    expect(pixyHid.setTrackingMode).toHaveBeenCalledWith("off");
    expect(audio.setMuted).not.toHaveBeenCalled();
  });

  it("saves runtime settings and updates the current settings state", async () => {
    mockedFetchSettings.mockResolvedValue(makeSettings(false));
    mockedUpdateSettings.mockResolvedValue(makeSettings(true));
    const pixyHid = makePixyHid();
    const audio = makeAudio();

    const { result } = renderHook(() => usePrivacySafety(pixyHid, audio));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    await act(async () => {
      await result.current.saveSettings({ safety: { start_in_privacy: true } });
    });

    expect(mockedUpdateSettings).toHaveBeenCalledWith({ safety: { start_in_privacy: true } });
    expect(result.current.settings?.safety.start_in_privacy).toBe(true);
    expect(result.current.startupPrivacyEnabled).toBe(true);
    // Saving the setting only changes what the service does at its next boot.
    expect(pixyHid.setTrackingMode).not.toHaveBeenCalled();
  });
});
