import { describe, expect, it } from "vitest";

import type { PixyHidQueryName, PixyHidRawQueryResult } from "../../types/api";
import {
  formatDegrees,
  hexToBytes,
  motorPositionFromQuery,
  motorSpeedFromQuery,
  presetStateFromQuery
} from "./hidTelemetry";

function floatsHex(...values: number[]): string {
  const buffer = new ArrayBuffer(4 * values.length);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function queryResult(name: PixyHidQueryName, responseHex: string | null): PixyHidRawQueryResult {
  return {
    name,
    request_hex: "",
    response_hex: responseHex,
    value_index: null,
    raw_value: null,
    raw_bits: [],
    ascii_value: null,
    ascii_preview: null,
    path: "/dev/hidraw0"
  };
}

describe("hidTelemetry decoders", () => {
  it("parses hex frames into bytes", () => {
    expect(Array.from(hexToBytes("09 63 01") ?? [])).toEqual([0x09, 0x63, 0x01]);
    expect(hexToBytes("")).toBeNull();
    expect(hexToBytes(null)).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
  });

  it("decodes motor position as (target, current) float32 pair", () => {
    const hex = `09 63 01 01 00 09 00 09 01 ${floatsHex(20.0, 19.85)}`;
    const position = motorPositionFromQuery(queryResult("motor_pos_pan", hex));
    expect(position?.target).toBeCloseTo(20.0, 5);
    expect(position?.current).toBeCloseTo(19.85, 5);
  });

  it("returns null for missing or truncated motor frames", () => {
    expect(motorPositionFromQuery(queryResult("motor_pos_pan", null))).toBeNull();
    expect(motorPositionFromQuery(queryResult("motor_pos_pan", "09 63 01"))).toBeNull();
  });

  it("decodes preset slot state with stored coordinates", () => {
    const hex = `09 03 01 16 00 0e 00 0e 02 01 ${floatsHex(-40.1, -0.8, 0)}`;
    const state = presetStateFromQuery(queryResult("preset_2_state", hex));
    expect(state?.slot).toBe(2);
    expect(state?.saved).toBe(true);
    expect(state?.pan).toBeCloseTo(-40.1, 4);
    expect(state?.tilt).toBeCloseTo(-0.8, 4);
  });

  it("marks empty preset slots as unsaved", () => {
    const hex = `09 03 01 16 00 0e 00 0e 03 00 ${floatsHex(0, 0, 0)}`;
    const state = presetStateFromQuery(queryResult("preset_3_state", hex));
    expect(state?.saved).toBe(false);
  });

  it("decodes motor speed in degrees per second", () => {
    const hex = `09 63 01 03 00 09 00 09 02 ${floatsHex(60)}`;
    expect(motorSpeedFromQuery(queryResult("motor_speed_tilt", hex))).toBeCloseTo(60, 5);
    expect(motorSpeedFromQuery(queryResult("motor_speed_tilt", null))).toBeNull();
  });
});

describe("formatDegrees", () => {
  it("formats signed degrees compactly", () => {
    expect(formatDegrees(0)).toBe("0°");
    expect(formatDegrees(-0.04)).toBe("0°");
    expect(formatDegrees(12)).toBe("+12°");
    expect(formatDegrees(-29.95)).toBe("-29.9°");
    expect(formatDegrees(-29.96)).toBe("-30°");
    expect(formatDegrees(1.55)).toBe("+1.6°");
    expect(formatDegrees(null)).toBe("—");
    expect(formatDegrees(Number.NaN)).toBe("—");
  });
});
