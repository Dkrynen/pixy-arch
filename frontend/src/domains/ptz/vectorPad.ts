import type { PtzVector } from "../../types/api";

export type PadPoint = {
  x: number;
  y: number;
};

export type PadBox = {
  width: number;
  height: number;
};

// Magnitude maps to gimbal velocity (~0.8°/s per unit at 60°/s motor speed):
// 30 whipped the camera at ~25°/s. 12 caps edge-drag near ~10°/s, and the
// easing curve keeps the inner pad for fine sub-degree nudges.
const PTZ_VECTOR_LIMIT = 12;
const PTZ_VECTOR_CURVE = 1.6;

export function ptzVectorFromPadPoint(box: PadBox, point: PadPoint): PtzVector {
  const size = Math.min(box.width, box.height);
  if (size <= 0) {
    return { x: 0, y: 0 };
  }

  const radius = size / 2;
  const center = { x: box.width / 2, y: box.height / 2 };
  const raw = {
    x: point.x - center.x,
    y: center.y - point.y
  };
  const distance = Math.hypot(raw.x, raw.y);
  if (distance === 0) {
    return { x: 0, y: 0 };
  }

  const magnitude = Math.pow(Math.min(distance, radius) / radius, PTZ_VECTOR_CURVE) * PTZ_VECTOR_LIMIT;

  return {
    x: roundVector((raw.x / distance) * magnitude),
    y: roundVector((raw.y / distance) * magnitude)
  };
}

export function vectorPadPosition(vector: PtzVector): PadPoint {
  return {
    x: 50 + (clampVector(vector.x) / PTZ_VECTOR_LIMIT) * 50,
    y: 50 - (clampVector(vector.y) / PTZ_VECTOR_LIMIT) * 50
  };
}

export function isCenteredVector(vector: PtzVector): boolean {
  return Math.abs(vector.x) < 0.5 && Math.abs(vector.y) < 0.5 && Math.abs(vector.z ?? 0) < 0.5;
}

function clampVector(value: number): number {
  return Math.min(PTZ_VECTOR_LIMIT, Math.max(-PTZ_VECTOR_LIMIT, value));
}

function roundVector(value: number): number {
  return Math.round(clampVector(value) * 10) / 10;
}
