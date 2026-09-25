import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import { SmartPixyPanel } from "./SmartPixyPanel";

function makePixyHid(overrides: Partial<UsePixyHidResult> = {}): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw14",
      readable: false,
      writable: false,
      reason: "HID device is present but not writable by this user",
      known_controls: ["tracking"]
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
    setTrackingMode: vi.fn(),
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
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setDefaultSource: vi.fn(),
    setMonitorRunning: vi.fn(),
    setMeterRunning: vi.fn(),
    restoreDefaultSource: vi.fn(),
    ...overrides
  };
}

function makePrivacySafety(overrides: Partial<UsePrivacySafetyResult> = {}): UsePrivacySafetyResult {
  return {
    settings: null,
    settingsLoaded: true,
    startupPrivacyEnabled: true,
    startupPrivacyState: "enabled",
    privacyCommandState: "idle",
    settingsError: null,
    settingsPending: false,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn(),
    enterPrivacy: vi.fn().mockResolvedValue(undefined),
    leavePrivacy: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("SmartPixyPanel", () => {
  it("shows permission state and disables HID controls when hidraw is not writable", () => {
    render(<SmartPixyPanel pixyHid={makePixyHid()} audio={makeAudio()} privacySafety={makePrivacySafety()} />);

    expect(screen.getByText("HID permission needed")).toBeInTheDocument();
    expect(screen.getByText("HID device is present but not writable by this user")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Standard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tracking" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Privacy" })).toBeDisabled();
  });

  it("enables HID controls when hidraw is writable", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking"]
          }
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("HID ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Standard" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tracking" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Privacy" })).toBeEnabled();
    expect(screen.queryByText("Speaker Tracking")).not.toBeInTheDocument();
    expect(screen.queryByText("Capture needed")).not.toBeInTheDocument();
    expect(screen.getByText("Startup privacy on; the service parks the lens when it starts")).toBeInTheDocument();
  });

  it("shows the outcome of the last privacy command instead of assuming success", () => {
    const { rerender } = render(
      <SmartPixyPanel
        pixyHid={makePixyHid()}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ privacyCommandState: "failed" })}
      />
    );
    expect(screen.getByText("Privacy command failed; press Privacy to retry")).toBeInTheDocument();

    rerender(
      <SmartPixyPanel
        pixyHid={makePixyHid()}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ privacyCommandState: "mic-failed" })}
      />
    );
    expect(screen.getByText("Privacy on, but the mic mute failed; check the mic")).toBeInTheDocument();

    rerender(
      <SmartPixyPanel
        pixyHid={makePixyHid()}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ privacyCommandState: "applied" })}
      />
    );
    expect(screen.getByText("Privacy on; mic muted")).toBeInTheDocument();
  });

  it("does not claim privacy is active when the refreshed HID state is unknown", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "privacy"]
          },
          trackingMode: null
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("Device mode is unknown after refresh. Select Privacy to send privacy mode now.")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Privacy" })).not.toHaveClass("is-selected");
  });

  it("shows non-privacy readback separately from the last commanded mode", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "privacy"]
          },
          trackingMode: "tracking",
          deviceTrackingState: "non_privacy",
          deviceTrackingRawValue: 3,
          deviceTrackingRawBits: [0, 1]
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("Non-privacy raw 3 bits 0,1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tracking" })).toHaveClass("is-selected");
  });

  it("keeps experimental target-tracking modes behind the collapsed Advanced section", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "target_tracking"]
          },
          trackingMode: "tracking",
          deviceTrackingState: "tracking",
          deviceTrackingRawValue: 1,
          deviceTrackingRawBits: [0],
          targetTrackingMode: "face",
          targetTrackingRawValue: 1
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("Tracking raw 1 bits 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tracking" })).toHaveClass("is-selected");
    expect(screen.getByText("Tracking mode is active. Focus target selection is handled in Focus Control: Center, Face, or Region.")).toBeInTheDocument();
    // Target tracking lives in Advanced and stays collapsed by default.
    expect(screen.queryByText("Tracking Target")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Half body" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Full body" })).not.toBeInTheDocument();
  });

  it("describes focus targeting separately while standard mode is selected", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "target_tracking"]
          },
          trackingMode: "off",
          deviceTrackingState: "standard",
          deviceTrackingRawValue: 0,
          targetTrackingMode: "off",
          targetTrackingRawValue: 0
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("Standard raw 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Standard" })).toHaveClass("is-selected");
    expect(screen.getByText("Device reports Standard mode. Select Tracking for auto follow, or use Focus Control for Center, Face, or Region metering.")).toBeInTheDocument();
    expect(screen.queryByText("Tracking Target")).not.toBeInTheDocument();
  });

  it("selects the proven tracking control mode", async () => {
    const user = userEvent.setup();
    const setTrackingMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking"]
          },
          setTrackingMode
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Tracking" }));

    expect(setTrackingMode).toHaveBeenCalledWith("tracking");
  });

  it("does not force target Face when Tracking mode is selected", async () => {
    const user = userEvent.setup();
    const setTrackingMode = vi.fn().mockResolvedValue(undefined);
    const setTargetTrackingMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "target_tracking"]
          },
          setTrackingMode,
          setTargetTrackingMode
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Tracking" }));

    expect(setTrackingMode).toHaveBeenCalledWith("tracking");
    expect(setTargetTrackingMode).not.toHaveBeenCalled();
  });

  it("shows privacy as the selected control mode after PixyPilot sends it", () => {
    const setTrackingMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["tracking", "privacy"]
          },
          trackingMode: "privacy",
          setTrackingMode
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByRole("button", { name: "Privacy" })).toHaveClass("is-selected");
    expect(setTrackingMode).not.toHaveBeenCalled();
  });

  it("enters privacy safety mode when privacy is pressed", async () => {
    const user = userEvent.setup();
    const enterPrivacy = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["privacy"]
          },
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ enterPrivacy })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Privacy" }));

    expect(enterPrivacy).toHaveBeenCalledTimes(1);
  });

  it("resends privacy when privacy mode is already selected", async () => {
    const user = userEvent.setup();
    const enterPrivacy = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["privacy"]
          },
          trackingMode: "privacy",
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ enterPrivacy })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Privacy" }));

    expect(enterPrivacy).toHaveBeenCalledTimes(1);
  });

  it("sends standard mode when privacy mode is cleared", async () => {
    const user = userEvent.setup();
    const setTrackingMode = vi.fn().mockResolvedValue(undefined);
    const leavePrivacy = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["privacy"]
          },
          trackingMode: "privacy",
          setTrackingMode
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety({ leavePrivacy })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Standard" }));

    expect(setTrackingMode).toHaveBeenCalledWith("off");
    expect(leavePrivacy).not.toHaveBeenCalled();
  });

  it("commits auto privacy on blur instead of every keystroke", async () => {
    const user = userEvent.setup();
    const setAutoPrivacySeconds = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["auto_privacy"]
          },
          setAutoPrivacySeconds
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "15");

    expect(setAutoPrivacySeconds).not.toHaveBeenCalled();

    await user.tab();

    expect(setAutoPrivacySeconds).toHaveBeenCalledWith(15);
  });

  it("offers captured auto privacy presets", async () => {
    const user = userEvent.setup();
    const setAutoPrivacySeconds = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["auto_privacy"]
          },
          setAutoPrivacySeconds
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "15m" }));

    expect(setAutoPrivacySeconds).toHaveBeenCalledWith(900);
    expect(screen.getByRole("spinbutton")).toHaveValue(900);
  });

  it("marks auto privacy as experimental until the trigger condition is confirmed", () => {
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["privacy", "auto_privacy"]
          },
          trackingMode: "off"
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText("Device mode is unknown after refresh. Select Privacy to send privacy mode now.")).toBeInTheDocument();
  });

  it("toggles the known gesture command", async () => {
    const user = userEvent.setup();
    const setGestureEnabled = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["gesture"]
          },
          setGestureEnabled
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Gesture Control" }));

    expect(setGestureEnabled).toHaveBeenCalledWith(true);
  });

  it("toggles the captured auto rotate command", async () => {
    const user = userEvent.setup();
    const setAutoRotateEnabled = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["auto_rotate"]
          },
          setAutoRotateEnabled
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Auto Rotate" }));

    expect(setAutoRotateEnabled).toHaveBeenCalledWith(true);
  });

  it("selects known audio DSP modes", async () => {
    const user = userEvent.setup();
    const setAudioMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid({
          status: {
            available: true,
            path: "/dev/hidraw14",
            readable: true,
            writable: true,
            reason: null,
            known_controls: ["audio_mode"]
          },
          setAudioMode
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Original" }));

    expect(setAudioMode).toHaveBeenCalledWith("original");
  });

  it("toggles standard mic mute through the audio hook", async () => {
    const user = userEvent.setup();
    const setMuted = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={makePixyHid()}
        audio={makeAudio({ setMuted })}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mic mute" }));

    expect(setMuted).toHaveBeenCalledWith(true);
  });

  it("shows a fix hint when hidraw is present but not writable", () => {
    render(<SmartPixyPanel pixyHid={makePixyHid()} audio={makeAudio()} privacySafety={makePrivacySafety()} />);

    expect(screen.getByText(/70-pixypilot-hid\.rules/)).toBeInTheDocument();
  });

  function writablePixyHid(overrides: Partial<UsePixyHidResult> = {}) {
    return makePixyHid({
      status: {
        available: true,
        path: "/dev/hidraw14",
        readable: true,
        writable: true,
        reason: null,
        known_controls: ["tracking", "mirror", "focus_metering", "wb_lock", "ev_lock", "focus_lock", "denoise", "remote_pairing", "power_on_default", "target_tracking", "motor_speed", "ptz_absolute"]
      },
      ...overrides
    });
  }

  it("selects mirror modes from the Orientation group", async () => {
    const user = userEvent.setup();
    const setMirrorMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel pixyHid={writablePixyHid({ setMirrorMode })} audio={makeAudio()} privacySafety={makePrivacySafety()} />
    );

    await user.click(screen.getByRole("button", { name: "HV" }));

    expect(setMirrorMode).toHaveBeenCalledWith("hv");
  });

  it("selects focus metering targets from the Focus group", async () => {
    const user = userEvent.setup();
    const setFocusMeteringMode = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ setFocusMeteringMode })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Region" }));

    expect(setFocusMeteringMode).toHaveBeenCalledWith("selected_area");
  });

  it("toggles imaging locks through their device-backed state", async () => {
    const user = userEvent.setup();
    const setWbLock = vi.fn().mockResolvedValue(undefined);
    const setDenoise = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ wbLockEnabled: true, denoiseEnabled: false, setWbLock, setDenoise })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByRole("button", { name: "WB lock" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "WB lock" }));
    await user.click(screen.getByRole("button", { name: "Denoise" }));

    expect(setWbLock).toHaveBeenCalledWith(false);
    expect(setDenoise).toHaveBeenCalledWith(true);
  });

  it("warns that denoise state is unverified when the device does not report it", () => {
    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ unsupportedReadbacks: ["denoise_state"] })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText(/does not report denoise state/)).toBeInTheDocument();
  });

  it("runs power-on default commands and shows the stored pose readback", async () => {
    const user = userEvent.setup();
    const capturePowerOnDefault = vi.fn().mockResolvedValue(undefined);
    const goToDefault = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({
          powerOnDefaultEnabled: true,
          powerOnDefaultPosition: { pan: 1.55, tilt: -5.86 },
          capturePowerOnDefault,
          goToDefault
        })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByText(/pan 1\.55°, tilt -5\.86°/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save current" }));
    await user.click(screen.getByRole("button", { name: "Go to" }));

    expect(capturePowerOnDefault).toHaveBeenCalledTimes(1);
    expect(goToDefault).toHaveBeenCalledTimes(1);
  });

  it("toggles remote pairing", async () => {
    const user = userEvent.setup();
    const setRemotePairing = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ setRemotePairing })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Remote pairing" }));

    expect(setRemotePairing).toHaveBeenCalledWith(true);
  });

  it("reveals experimental target tracking and motor controls inside Advanced", async () => {
    const user = userEvent.setup();
    const setTargetTrackingMode = vi.fn().mockResolvedValue(undefined);
    const sendPtzAbsolute = vi.fn().mockResolvedValue(undefined);

    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ setTargetTrackingMode, sendPtzAbsolute, motorPosPanDeg: 1.4, motorPosTiltDeg: -6.2 })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.queryByRole("button", { name: "Half body" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced" }));

    await user.click(screen.getByRole("button", { name: "Half body" }));
    expect(setTargetTrackingMode).toHaveBeenCalledWith("half_body");

    expect(screen.getByText(/pan 1\.4°, tilt -6\.2°/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(sendPtzAbsolute).toHaveBeenCalledWith(0, 0);
  });

  it("keeps the mic gain slider live while dragging and commits once on release", () => {
    const setVolume = vi.fn().mockResolvedValue(true);
    render(
      <SmartPixyPanel
        pixyHid={makePixyHid()}
        audio={makeAudio({ setVolume, pending: true })}
        privacySafety={makePrivacySafety()}
      />
    );

    const gain = screen.getByRole("slider", { name: "Mic gain" });
    // A pending audio command must not disable the slider mid-drag.
    expect(gain).toBeEnabled();

    fireEvent.change(gain, { target: { value: "35" } });
    fireEvent.change(gain, { target: { value: "42" } });
    expect(setVolume).not.toHaveBeenCalled();
    expect(gain).toHaveValue("42");
    expect(screen.getByText("Gain 42")).toBeInTheDocument();

    fireEvent.pointerUp(gain);
    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenCalledWith(42);

    fireEvent.blur(gain);
    expect(setVolume).toHaveBeenCalledTimes(1);
  });

  it("commits keyboard gain changes on key release", () => {
    const setVolume = vi.fn().mockResolvedValue(true);
    render(<SmartPixyPanel pixyHid={makePixyHid()} audio={makeAudio({ setVolume })} privacySafety={makePrivacySafety()} />);

    const gain = screen.getByRole("slider", { name: "Mic gain" });
    fireEvent.change(gain, { target: { value: "11" } });
    fireEvent.keyUp(gain, { key: "ArrowRight" });

    expect(setVolume).toHaveBeenCalledWith(11);
  });

  it("exposes segmented selections as pressed toggle buttons and names its inputs", async () => {
    const user = userEvent.setup();
    render(
      <SmartPixyPanel
        pixyHid={writablePixyHid({ trackingMode: "tracking", audioMode: "live", autoPrivacySeconds: 60 })}
        audio={makeAudio()}
        privacySafety={makePrivacySafety()}
      />
    );

    expect(screen.getByRole("button", { name: "Tracking" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1m" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("spinbutton", { name: "Auto-privacy delay in seconds" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("slider", { name: "Pan motor speed" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Tilt motor speed" })).toBeInTheDocument();
  });
});
