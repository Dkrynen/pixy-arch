import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Crosshair } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import type { ControlGroup } from "../../domains/controls/grouping";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { PixyHidQueryName, PixyHidRawQueryResult, V4L2Control } from "../../types/api";
import { PtzControlPanel } from "./PtzControlPanel";

function control(overrides: Partial<V4L2Control>): V4L2Control {
  return {
    name: "pan_absolute",
    label: "Pan",
    control_id: "0x1",
    group: "Camera Controls",
    kind: "int",
    value: 0,
    default: 0,
    min: -100,
    max: 100,
    step: 10,
    value_label: null,
    flags: [],
    menu: [],
    ...overrides
  };
}

function pixyHid(overrides: Partial<UsePixyHidResult> = {}): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw14",
      readable: true,
      writable: false,
      reason: "HID device is present but not writable by this user",
      known_controls: []
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

function floatsHex(...values: number[]): string {
  const buffer = new ArrayBuffer(4 * values.length);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function motorPosResponse(axis: number, target: number, current: number): string {
  return `09 63 01 01 00 09 00 09 0${axis} ${floatsHex(target, current)}`;
}

function presetStateResponse(slot: number, saved: boolean, pan: number, tilt: number): string {
  return `09 03 01 16 00 0e 00 0e 0${slot} 0${saved ? 1 : 0} ${floatsHex(pan, tilt, 0)}`;
}

function motorSpeedResponse(axis: number, degreesPerSecond: number): string {
  return `09 63 01 03 00 09 00 09 0${axis} ${floatsHex(degreesPerSecond)}`;
}

function hidQuery(
  responses: Partial<Record<PixyHidQueryName, string | null>>
): (name: PixyHidQueryName) => Promise<PixyHidRawQueryResult> {
  return vi.fn(async (name: PixyHidQueryName) => ({
    name,
    request_hex: "",
    response_hex: responses[name] ?? null,
    value_index: null,
    raw_value: null,
    raw_bits: [],
    ascii_value: null,
    ascii_preview: null,
    path: "/dev/hidraw0"
  }));
}

function writablePixyHid(knownControls: string[], overrides: Partial<UsePixyHidResult> = {}): UsePixyHidResult {
  return pixyHid({
    status: {
      available: true,
      path: "/dev/hidraw0",
      readable: true,
      writable: true,
      reason: null,
      known_controls: knownControls
    },
    ...overrides
  });
}

function renderPanel(
  setValue = vi.fn().mockResolvedValue(undefined),
  pixyHidState: UsePixyHidResult = pixyHid(),
  queryHid?: (name: PixyHidQueryName) => Promise<PixyHidRawQueryResult>
) {
  const group: ControlGroup = {
    id: "ptz",
    title: "PTZ Drive",
    accent: "cyan",
    icon: Crosshair,
    controls: [
      control({ name: "pan_absolute", label: "Pan", value: 20 }),
      control({ name: "tilt_absolute", label: "Tilt", value: 30 }),
      control({ name: "zoom_absolute", label: "Zoom", value: 50, min: 0, max: 80, step: 5 })
    ]
  };
  const controls: UseControlsResult = {
    controls: group.controls,
    groups: [group],
    isLoading: false,
    error: null,
    pendingControl: null,
    refresh: vi.fn(),
    setValue,
    setValues: vi.fn()
  };

  render(<PtzControlPanel group={group} controls={controls} pixyHid={pixyHidState} queryHid={queryHid} />);
  return setValue;
}

function padRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({})
  };
}

describe("PtzControlPanel", () => {
  it("moves pan by the exposed V4L2 step", async () => {
    const user = userEvent.setup();
    const setValue = renderPanel();

    await user.click(screen.getByRole("button", { name: "Pan left" }));

    expect(setValue).toHaveBeenCalledWith("pan_absolute", 10);
  });

  it("homes pan, tilt, and zoom controls", async () => {
    const setValue = renderPanel();
    const centerButton = screen.getByRole("button", { name: "Center PTZ" });
    vi.spyOn(centerButton, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      toJSON: () => ({})
    });

    fireEvent.pointerUp(centerButton, { clientX: 50, clientY: 50 });

    await waitFor(() => expect(setValue).toHaveBeenCalledWith("pan_absolute", 0));
    await waitFor(() => expect(setValue).toHaveBeenCalledWith("tilt_absolute", 0));
    await waitFor(() => expect(setValue).toHaveBeenCalledWith("zoom_absolute", 0));
  });

  it("sets zoom from the visible zoom slider", () => {
    const setValue = renderPanel();

    const zoomSlider = screen.getAllByRole("slider")[2];
    fireEvent.change(zoomSlider, { target: { value: "65" } });
    fireEvent.blur(zoomSlider);

    expect(setValue).toHaveBeenCalledWith("zoom_absolute", 65);
  });

  it("saves and recalls a PTZ preset", async () => {
    const user = userEvent.setup();
    const setValue = renderPanel();

    await user.click(screen.getByRole("button", { name: "Save PTZ preset" }));
    await user.click(screen.getByRole("button", { name: "Go to PTZ preset" }));

    expect(setValue).toHaveBeenCalledWith("pan_absolute", 20);
    expect(setValue).toHaveBeenCalledWith("tilt_absolute", 30);
    expect(setValue).toHaveBeenCalledWith("zoom_absolute", 50);
  });

  it("uses the captured HID save command when native preset saving is available", async () => {
    const user = userEvent.setup();
    const savePtzPreset = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_preset_save"]
        },
        savePtzPreset
      })
    );

    await user.click(screen.getByRole("button", { name: "Preset 2" }));
    await user.click(screen.getByRole("button", { name: "Save PTZ preset" }));

    expect(savePtzPreset).toHaveBeenCalledWith(2);
  });

  it("does not mark a preset slot as saved when the device rejects the save", async () => {
    const user = userEvent.setup();
    const savePtzPreset = vi.fn().mockResolvedValue(false);
    renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_preset_save"], { savePtzPreset }), hidQuery({}));

    await user.click(screen.getByRole("button", { name: "Save PTZ preset" }));

    expect(savePtzPreset).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Preset 1" })).not.toHaveClass("is-filled");
  });

  it("marks a preset slot as saved once the device accepts the save", async () => {
    const user = userEvent.setup();
    const savePtzPreset = vi.fn().mockResolvedValue(true);
    renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_preset_save"], { savePtzPreset }), hidQuery({}));

    await user.click(screen.getByRole("button", { name: "Save PTZ preset" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Preset 1" })).toHaveClass("is-filled"));
  });

  it("uses the captured HID load command when native preset loading is available", async () => {
    const user = userEvent.setup();
    const setValue = vi.fn().mockResolvedValue(undefined);
    const loadPtzPreset = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_preset_load"]
        },
        loadPtzPreset
      })
    );

    await user.click(screen.getByRole("button", { name: "Preset 3" }));
    await user.click(screen.getByRole("button", { name: "Go to PTZ preset" }));

    expect(loadPtzPreset).toHaveBeenCalledWith(3);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("allows speed selection for PTZ jog controls", async () => {
    const user = userEvent.setup();
    const setValue = renderPanel();

    await user.click(screen.getByRole("button", { name: "Speed 1" }));
    await user.click(screen.getByRole("button", { name: "Pan right" }));

    expect(setValue).toHaveBeenCalledWith("pan_absolute", 30);
  });

  it("uses the captured HID PTZ jog command when available", async () => {
    const user = userEvent.setup();
    const setValue = vi.fn().mockResolvedValue(undefined);
    const sendPtzDirection = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_direction"]
        },
        sendPtzDirection
      })
    );

    await user.click(screen.getByRole("button", { name: "Pan left" }));

    expect(sendPtzDirection).toHaveBeenCalledWith("left");
    expect(setValue).not.toHaveBeenCalled();
  });

  it("locks all PTZ controls while Tracking Mode owns the camera", async () => {
    const user = userEvent.setup();
    const setValue = vi.fn().mockResolvedValue(undefined);
    const sendPtzDirection = vi.fn().mockResolvedValue(undefined);
    const savePtzPreset = vi.fn().mockResolvedValue(undefined);
    const loadPtzPreset = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_direction", "ptz_preset_save", "ptz_preset_load"]
        },
        trackingMode: "tracking",
    deviceTrackingState: "unknown",
    deviceTrackingRawValue: null,
    deviceTrackingRawBits: [],
        sendPtzDirection,
        savePtzPreset,
        loadPtzPreset
      })
    );

    expect(screen.getByText("Tracking is steering the camera. Manual moves, zoom and presets are paused.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Standard" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pan left" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Center PTZ" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Home PTZ" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save PTZ preset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go to PTZ preset" })).toBeDisabled();
    expect(screen.getAllByRole("slider")[2]).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Pan left" }));

    expect(sendPtzDirection).not.toHaveBeenCalled();
    expect(savePtzPreset).not.toHaveBeenCalled();
    expect(loadPtzPreset).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it("offers a one-click switch back to Standard while Tracking owns PTZ", async () => {
    const user = userEvent.setup();
    const setTrackingMode = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_direction"]
        },
        trackingMode: "tracking",
        setTrackingMode
      })
    );

    await user.click(screen.getByRole("button", { name: "Switch to Standard" }));

    expect(setTrackingMode).toHaveBeenCalledWith("off");
  });

  it("prefers the captured discrete HID jog command for arrows when both PTZ paths are available", async () => {
    const user = userEvent.setup();
    const setValue = vi.fn().mockResolvedValue(undefined);
    const sendPtzDirection = vi.fn().mockResolvedValue(undefined);
    const sendPtzVector = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_direction", "ptz_vector"]
        },
        sendPtzDirection,
        sendPtzVector
      })
    );

    await user.click(screen.getByRole("button", { name: "Speed 5" }));
    await user.click(screen.getByRole("button", { name: "Pan right" }));

    await waitFor(() => expect(sendPtzDirection).toHaveBeenCalledWith("right"));
    expect(sendPtzVector).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it("stops fallback HID vector movement on pointer release", async () => {
    const setValue = vi.fn().mockResolvedValue(undefined);
    const sendPtzVector = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_vector"]
        },
        sendPtzVector
      })
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Pan right" }));
    fireEvent.pointerUp(screen.getByRole("button", { name: "Pan right" }));

    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledWith({ x: 6, y: 0 }));
    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }));
    expect(setValue).not.toHaveBeenCalled();
  });

  it("uses the captured HID PTZ vector command from the center pad", async () => {
    const setValue = vi.fn().mockResolvedValue(undefined);
    const sendPtzVector = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      setValue,
      pixyHid({
        status: {
          available: true,
          path: "/dev/hidraw14",
          readable: true,
          writable: true,
          reason: null,
          known_controls: ["ptz_vector"]
        },
        sendPtzVector
      })
    );
    const centerButton = screen.getByRole("button", { name: "Center PTZ" });
    vi.spyOn(centerButton, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(centerButton, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(centerButton, { clientX: 100, clientY: 50, buttons: 1 });
    fireEvent.pointerUp(centerButton, { clientX: 100, clientY: 50 });

    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledWith({ x: 12, y: 0 }));
    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }));
    expect(setValue).not.toHaveBeenCalled();
    expect(centerButton.querySelector(".ptz-vector-puck")).toBeNull();
  });

  it("keeps re-sending the held pad vector as a heartbeat for the backend dead-man", async () => {
    const sendPtzVector = vi.fn().mockResolvedValue(true);
    renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_vector"], { sendPtzVector }), hidQuery({}));
    const centerButton = screen.getByRole("button", { name: "Center PTZ" });
    vi.spyOn(centerButton, "getBoundingClientRect").mockReturnValue(padRect());

    // Pointer held still off-center: no pointermove events arrive.
    fireEvent.pointerDown(centerButton, { clientX: 100, clientY: 50 });

    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(sendPtzVector.mock.calls.every(([vector]) => vector.x === 12 && vector.y === 0)).toBe(true);

    fireEvent.pointerUp(centerButton, { clientX: 100, clientY: 50 });
    await waitFor(() => expect(sendPtzVector).toHaveBeenLastCalledWith({ x: 0, y: 0, z: 0 }));
  });

  it("retries the pad stop when the device rejects it", async () => {
    let stopAttempts = 0;
    const sendPtzVector = vi.fn(async (vector: { x: number; y: number }) => {
      if (vector.x === 0 && vector.y === 0) {
        stopAttempts += 1;
        return stopAttempts > 1;
      }
      return true;
    });
    renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_vector"], { sendPtzVector }), hidQuery({}));
    const centerButton = screen.getByRole("button", { name: "Center PTZ" });
    vi.spyOn(centerButton, "getBoundingClientRect").mockReturnValue(padRect());

    fireEvent.pointerDown(centerButton, { clientX: 100, clientY: 50 });
    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledTimes(1));
    fireEvent.pointerUp(centerButton, { clientX: 100, clientY: 50 });

    await waitFor(() => expect(stopAttempts).toBe(2));
  });

  it("sends a keepalive stop when the window loses focus mid-drag", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      const sendPtzVector = vi.fn().mockResolvedValue(true);
      renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_vector"], { sendPtzVector }), hidQuery({}));
      const centerButton = screen.getByRole("button", { name: "Center PTZ" });
      vi.spyOn(centerButton, "getBoundingClientRect").mockReturnValue(padRect());

      fireEvent.pointerDown(centerButton, { clientX: 100, clientY: 50 });
      await waitFor(() => expect(sendPtzVector).toHaveBeenCalledTimes(1));
      fireEvent.blur(window);

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pixy-hid/ptz-vector",
        expect.objectContaining({ method: "PATCH", keepalive: true, body: JSON.stringify({ x: 0, y: 0, z: 0 }) })
      );
      expect(centerButton.querySelector(".ptz-vector-puck")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stops keyboard vector nudges when the arrow key is released", async () => {
    const sendPtzVector = vi.fn().mockResolvedValue(true);
    renderPanel(vi.fn().mockResolvedValue(undefined), writablePixyHid(["ptz_vector"], { sendPtzVector }), hidQuery({}));
    const pad = screen.getByRole("group", { name: "Pan and tilt controls" });

    fireEvent.keyDown(pad, { key: "ArrowRight" });
    await waitFor(() => expect(sendPtzVector).toHaveBeenCalledWith({ x: 6, y: 0 }));
    fireEvent.keyUp(pad, { key: "ArrowRight" });

    await waitFor(() => expect(sendPtzVector).toHaveBeenLastCalledWith({ x: 0, y: 0, z: 0 }));
  });

  it("recenters from the keyboard with Enter or Space on the center button", async () => {
    const setValue = renderPanel();
    const centerButton = screen.getByRole("button", { name: "Center PTZ" });

    fireEvent.keyDown(centerButton, { key: "Enter" });
    await waitFor(() => expect(setValue).toHaveBeenCalledWith("pan_absolute", 0));

    setValue.mockClear();
    fireEvent.keyDown(centerButton, { key: " " });
    await waitFor(() => expect(setValue).toHaveBeenCalledWith("tilt_absolute", 0));
  });

  it("names the pad group, describes its keyboard support, and labels the zoom slider", () => {
    renderPanel();

    const pad = screen.getByRole("group", { name: "Pan and tilt controls" });
    expect(pad).toHaveAccessibleDescription(/Arrow keys nudge pan and tilt; Home recenters/);
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
  });

  it("shows the live gimbal position decoded from motor queries", async () => {
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["ptz_absolute", "ptz_direction"]),
      hidQuery({
        motor_pos_pan: motorPosResponse(1, 12.5, 12.4),
        motor_pos_tilt: motorPosResponse(2, -30, -29.9)
      })
    );

    await waitFor(() =>
      expect(screen.getByText((_content, element) => element?.textContent === "pan +12.4° · tilt -29.9°")).toBeInTheDocument()
    );
  });

  it("drives the gimbal with sendPtzAbsolute from the degree sliders", async () => {
    const sendPtzAbsolute = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["ptz_absolute"], { sendPtzAbsolute }),
      hidQuery({
        motor_pos_pan: motorPosResponse(1, 0, 0),
        motor_pos_tilt: motorPosResponse(2, -10, -10)
      })
    );

    const panSlider = await waitFor(() => {
      const slider = screen.getByRole("slider", { name: "Pan position" });
      expect(slider).toBeEnabled();
      return slider;
    });

    fireEvent.change(panSlider, { target: { value: "25" } });
    fireEvent.pointerUp(panSlider);

    await waitFor(() => expect(sendPtzAbsolute).toHaveBeenCalledWith(25, -10));
  });

  it("keeps HID sliders disabled until the first position reading arrives", async () => {
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["ptz_absolute"]),
      hidQuery({})
    );

    expect(screen.getByRole("slider", { name: "Pan position" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Tilt position" })).toBeDisabled();
  });

  it("programs the motor speed on both axes when a speed is picked", async () => {
    const user = userEvent.setup();
    const setMotorSpeed = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["motor_speed"], { setMotorSpeed }),
      hidQuery({ motor_speed_pan: motorSpeedResponse(1, 60) })
    );

    await user.click(screen.getByRole("button", { name: "Speed 5" }));

    await waitFor(() => expect(setMotorSpeed).toHaveBeenCalledWith(1, 240));
    await waitFor(() => expect(setMotorSpeed).toHaveBeenCalledWith(2, 240));
  });

  it("preselects the speed closest to the device's motor speed", async () => {
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["motor_speed"]),
      hidQuery({ motor_speed_pan: motorSpeedResponse(1, 118) })
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Speed 4" })).toHaveClass("is-selected")
    );
  });

  it("hydrates preset slots from device state and blocks goto on empty slots", async () => {
    const loadPtzPreset = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["ptz_preset_load", "ptz_preset_save", "ptz_preset_clear"], { loadPtzPreset }),
      hidQuery({
        preset_1_state: presetStateResponse(1, true, 10, -20),
        preset_2_state: presetStateResponse(2, false, 0, 0),
        preset_3_state: presetStateResponse(3, true, -5, 5)
      })
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preset 1" })).toHaveAttribute(
        "title",
        "Preset 1 · pan +10° tilt -20°"
      )
    );
    expect(screen.getByRole("button", { name: "Preset 1" })).toHaveClass("is-filled");
    expect(screen.getByRole("button", { name: "Preset 3" })).toHaveClass("is-filled");

    await userEvent.setup().click(screen.getByRole("button", { name: "Preset 2" }));
    expect(screen.getByRole("button", { name: "Go to PTZ preset" })).toBeDisabled();
    expect(loadPtzPreset).not.toHaveBeenCalled();
  });

  it("nudges with arrow keys from the jog pad", async () => {
    const sendPtzDirection = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      vi.fn().mockResolvedValue(undefined),
      writablePixyHid(["ptz_direction"], { sendPtzDirection }),
      hidQuery({})
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Pan left" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Tilt up" }), { key: "ArrowUp" });

    await waitFor(() => expect(sendPtzDirection).toHaveBeenCalledWith("left"));
    await waitFor(() => expect(sendPtzDirection).toHaveBeenCalledWith("up"));
  });

  it("surfaces pixyHid errors inside the panel", () => {
    renderPanel(vi.fn().mockResolvedValue(undefined), pixyHid({ error: "gimbal stalled" }));

    expect(screen.getByRole("alert")).toHaveTextContent("gimbal stalled");
  });
});
