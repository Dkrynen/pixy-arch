import { describe, expect, it } from "vitest";

import {
  arcsecondsToDegrees,
  formatZoomFactor,
  isAngularControl,
  ptzScaleLabels,
  ptzValueText,
  zoomFactor
} from "./units";

describe("ptz units", () => {
  it("converts V4L2 arcseconds to degrees", () => {
    expect(arcsecondsToDegrees(3600)).toBe(1);
    expect(arcsecondsToDegrees(44640)).toBeCloseTo(12.4);
    expect(arcsecondsToDegrees(-522000)).toBe(-145);
  });

  it("identifies the angular pan and tilt controls", () => {
    expect(isAngularControl("pan_absolute")).toBe(true);
    expect(isAngularControl("tilt_absolute")).toBe(true);
    expect(isAngularControl("zoom_absolute")).toBe(false);
  });

  it("derives a zoom multiplier from the widest setting", () => {
    expect(zoomFactor(100, 100)).toBe(1);
    expect(zoomFactor(120, 100)).toBeCloseTo(1.2);
    expect(zoomFactor(400, 100)).toBe(4);
    // Degenerate minimums fall back to a unit base and never go below 1×.
    expect(zoomFactor(0, 1)).toBe(1);
    expect(zoomFactor(3, 0)).toBe(3);
    expect(zoomFactor(2, null)).toBe(2);
  });

  it("formats zoom multipliers with one decimal", () => {
    expect(formatZoomFactor(1)).toBe("1.0×");
    expect(formatZoomFactor(2.25)).toBe("2.3×");
    expect(formatZoomFactor(Number.NaN)).toBe("—");
  });

  it("formats axis values in human units", () => {
    expect(ptzValueText("pan_absolute", 44640, -522000)).toBe("+12.4°");
    expect(ptzValueText("tilt_absolute", -10800, -324000)).toBe("-3°");
    expect(ptzValueText("pan_absolute", 0, -522000)).toBe("0°");
    expect(ptzValueText("zoom_absolute", 120, 100)).toBe("1.2×");
    expect(ptzValueText("focus_absolute", 280, 0)).toBe("280");
  });

  it("builds slider scale labels in human units", () => {
    expect(ptzScaleLabels({ name: "pan_absolute", min: -522000, max: 522000 })).toEqual(["-145°", "0°", "+145°"]);
    expect(ptzScaleLabels({ name: "zoom_absolute", min: 100, max: 400 })).toEqual(["1.0×", "", "4.0×"]);
    expect(ptzScaleLabels({ name: "gain", min: 0, max: 100 })).toEqual(["0", "", "100"]);
  });
});
