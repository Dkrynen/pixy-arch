import { describe, expect, it } from "vitest";

import type { V4L2Control } from "../../types/api";
import {
  boolOptionLabels,
  controlDisplayLabel,
  controlNumberText,
  dependencyAction,
  dependencyHint,
  rawControlTitle
} from "./display";

function control(overrides: Partial<V4L2Control>): V4L2Control {
  return {
    name: "brightness",
    label: "Brightness",
    control_id: "0x1",
    group: "User Controls",
    kind: "int",
    value: 0,
    default: 0,
    min: 0,
    max: 255,
    step: 1,
    value_label: null,
    flags: [],
    menu: [],
    ...overrides
  };
}

describe("controlDisplayLabel", () => {
  it("maps vendor labels to the compact EMEET Studio labels", () => {
    expect(controlDisplayLabel(control({ name: "auto_exposure" }))).toBe("AE Mode");
    expect(controlDisplayLabel(control({ name: "exposure_time_absolute" }))).toBe("Exposure");
    expect(controlDisplayLabel(control({ name: "gain" }))).toBe("ISO");
    expect(controlDisplayLabel(control({ name: "hue" }))).toBe("Tone");
    expect(controlDisplayLabel(control({ name: "white_balance_automatic" }))).toBe("AWB");
    expect(controlDisplayLabel(control({ name: "white_balance_temperature" }))).toBe("WB");
  });

  it("falls back to the driver label for unmapped controls", () => {
    expect(controlDisplayLabel(control({ name: "sharpness", label: "Sharpness" }))).toBe("Sharpness");
    expect(controlDisplayLabel(control({ name: "focus_automatic_continuous", label: "Focus, Automatic Continuous" }))).toBe("Focus Mode");
    expect(controlDisplayLabel(control({ name: "exposure_dynamic_framerate", label: "Exposure, Dynamic Framerate" }))).toBe("Dynamic Framerate");
  });
});

describe("dependencyHint", () => {
  it("is null for active controls", () => {
    expect(dependencyHint(control({ name: "exposure_time_absolute" }), [])).toBeNull();
  });

  it("names the current menu state when unlocking manual exposure", () => {
    const controls = [
      control({
        name: "auto_exposure",
        kind: "menu",
        value: 3,
        value_label: "Aperture Priority Mode",
        menu: [
          { value: 1, label: "Manual Mode" },
          { value: 3, label: "Aperture Priority Mode" }
        ]
      }),
      control({ name: "exposure_time_absolute", flags: ["inactive"] })
    ];

    expect(dependencyHint(controls[1], controls)).toBe("AE Mode: Auto. Set to Manual.");
  });

  it("names the current bool state for focus mode", () => {
    const controls = [
      control({ name: "focus_automatic_continuous", kind: "bool", value: 1 }),
      control({ name: "focus_absolute", flags: ["inactive"] })
    ];

    expect(dependencyHint(controls[1], controls)).toBe("Focus Mode: Auto. Set to Manual.");
  });

  it("names the current bool state for white balance", () => {
    const controls = [
      control({ name: "white_balance_automatic", kind: "bool", value: 1 }),
      control({ name: "white_balance_temperature", flags: ["inactive"] })
    ];

    expect(dependencyHint(controls[1], controls)).toBe("AWB: Auto. Set to Lock.");
  });

  it("still explains the unlock when the parent control is missing", () => {
    const inactive = control({ name: "focus_absolute", flags: ["inactive"] });

    expect(dependencyHint(inactive, [])).toBe("Set Focus Mode to Manual");
  });
});

describe("dependencyAction", () => {
  it("offers a one-click unlock for each dependent control", () => {
    const controls = [
      control({ name: "auto_exposure", kind: "menu" }),
      control({ name: "white_balance_automatic", kind: "bool" }),
      control({ name: "focus_automatic_continuous", kind: "bool" })
    ];

    expect(dependencyAction(control({ name: "exposure_time_absolute", flags: ["inactive"] }), controls)).toEqual({
      parentName: "auto_exposure",
      value: 1,
      label: "Manual AE"
    });
    expect(dependencyAction(control({ name: "white_balance_temperature", flags: ["inactive"] }), controls)).toEqual({
      parentName: "white_balance_automatic",
      value: 0,
      label: "Lock WB"
    });
    expect(dependencyAction(control({ name: "focus_absolute", flags: ["inactive"] }), controls)).toEqual({
      parentName: "focus_automatic_continuous",
      value: 0,
      label: "Manual Focus"
    });
  });

  it("returns null for active controls and when the parent is unavailable", () => {
    const controls = [control({ name: "auto_exposure", kind: "menu" })];

    expect(dependencyAction(control({ name: "exposure_time_absolute" }), controls)).toBeNull();
    expect(dependencyAction(control({ name: "exposure_time_absolute", flags: ["inactive"] }), [])).toBeNull();
  });
});

describe("boolOptionLabels", () => {
  it("labels white balance as Auto/Lock", () => {
    expect(boolOptionLabels(control({ name: "white_balance_automatic", kind: "bool" }))).toEqual([
      { value: 1, label: "Auto" },
      { value: 0, label: "Lock" }
    ]);
  });

  it("labels focus and other auto toggles as Auto/Manual", () => {
    expect(boolOptionLabels(control({ name: "focus_automatic_continuous", kind: "bool" }))[1].label).toBe("Manual");
  });

  it("labels plain booleans as Off/On", () => {
    expect(boolOptionLabels(control({ name: "some_switch", kind: "bool" }))).toEqual([
      { value: 0, label: "Off" },
      { value: 1, label: "On" }
    ]);
  });

  it("adds units to numeric readouts where the driver implies one", () => {
    expect(controlNumberText("white_balance_temperature", 4600)).toBe("4600 K");
    expect(controlNumberText("brightness", 128)).toBe("128");
  });

  it("keeps the raw control details for tooltips", () => {
    expect(rawControlTitle({ name: "pan_absolute", value: 3600, min: -522000, max: 522000, step: 3600 })).toBe(
      "pan_absolute · raw 3600 · range -522000..522000 · step 3600"
    );
    expect(rawControlTitle({ name: "gain", value: 5, min: null, max: null, step: 1 })).toBe("gain · raw 5");
  });
});
