import type { PixyHidRawQueryResult } from "../../types/api";

/**
 * Decoders for the raw HID query frames the pixy-hid domain exposes through
 * GET /api/pixy-hid/query/{name}. The firmware answers every motor query with
 * little-endian float32 fields; the query endpoint only hands us hex, so the
 * panel decodes it here.
 */

export const PTZ_PAN_RANGE_DEGREES = 150;
export const PTZ_TILT_RANGE_DEGREES = 90;

/** Degrees/second each UI speed step programs on both gimbal axes. */
export const PTZ_MOTOR_SPEED_DPS: Record<number, number> = {
  1: 20,
  2: 40,
  3: 60,
  4: 120,
  5: 240
};

export type MotorPosition = {
  /** Position the gimbal was commanded to, in degrees. */
  target: number;
  /** Measured gimbal position, in degrees. Lags target while moving. */
  current: number;
};

export type PresetSlotState = {
  slot: number;
  saved: boolean;
  pan: number;
  tilt: number;
};

export function hexToBytes(hex: string | null | undefined): Uint8Array | null {
  if (!hex) {
    return null;
  }
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let index = 0; index < cleaned.length; index += 2) {
    bytes[index / 2] = Number.parseInt(cleaned.slice(index, index + 2), 16);
  }
  return bytes;
}

function readFloat32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  const value = view.getFloat32(0, true);
  return Number.isFinite(value) ? value : null;
}

/**
 * motor_pos_pan / motor_pos_tilt responses carry the axis byte at index 8
 * followed by two float32s: the commanded target and the measured position.
 */
export function motorPositionFromQuery(result: PixyHidRawQueryResult | null | undefined): MotorPosition | null {
  const bytes = hexToBytes(result?.response_hex);
  if (!bytes) {
    return null;
  }
  const target = readFloat32LE(bytes, 9);
  const current = readFloat32LE(bytes, 13);
  if (target === null || current === null) {
    return null;
  }
  return { target, current };
}

/**
 * preset_N_state responses carry the slot at index 8, a saved flag at index 9,
 * then the stored pan and tilt as float32s.
 */
export function presetStateFromQuery(result: PixyHidRawQueryResult | null | undefined): PresetSlotState | null {
  const bytes = hexToBytes(result?.response_hex);
  if (!bytes || bytes.length < 18) {
    return null;
  }
  const slot = bytes[8];
  const pan = readFloat32LE(bytes, 10);
  const tilt = readFloat32LE(bytes, 14);
  if (pan === null || tilt === null) {
    return null;
  }
  return { slot, saved: bytes[9] === 1, pan, tilt };
}

/** motor_speed_pan / motor_speed_tilt responses carry degrees/second at index 9. */
export function motorSpeedFromQuery(result: PixyHidRawQueryResult | null | undefined): number | null {
  const bytes = hexToBytes(result?.response_hex);
  if (!bytes) {
    return null;
  }
  return readFloat32LE(bytes, 9);
}

/** "+12.5°" / "0°" — compact degree readout for gimbal axes. */
export function formatDegrees(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  if (Object.is(rounded, -0)) {
    return "0°";
  }
  const text = Math.abs(rounded) % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(1);
  return `${rounded > 0 ? "+" : ""}${text}°`;
}
