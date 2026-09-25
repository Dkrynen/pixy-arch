import { describe, expect, it } from "vitest";

import { rangeFill, rangeFillPercent } from "./rangeFill";

describe("rangeFill", () => {
  it("maps a value onto the track as a percentage", () => {
    expect(rangeFillPercent(0, 0, 100)).toBe(0);
    expect(rangeFillPercent(50, 0, 100)).toBe(50);
    expect(rangeFillPercent(128, 0, 255)).toBe(50.2);
    expect(rangeFillPercent(0, -180, 180)).toBe(50);
  });

  it("clamps out-of-range values and tolerates degenerate ranges", () => {
    expect(rangeFillPercent(-5, 0, 10)).toBe(0);
    expect(rangeFillPercent(15, 0, 10)).toBe(100);
    expect(rangeFillPercent(3, 5, 5)).toBe(0);
    expect(rangeFillPercent(Number.NaN, 0, 10)).toBe(0);
    expect(rangeFillPercent(40, null, null)).toBe(40);
  });

  it("exposes the fill as a CSS custom property", () => {
    expect(rangeFill(25, 0, 100)).toEqual({ "--fill": "25%" });
  });
});
