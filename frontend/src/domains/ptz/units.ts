import type { V4L2Control } from "../../types/api";
import { formatDegrees } from "./hidTelemetry";

/**
 * Human-unit formatting for the V4L2 PTZ controls. The UVC spec reports
 * pan_absolute / tilt_absolute in arcseconds (3600 per degree) and
 * zoom_absolute as an abstract focal-length value whose minimum is 1× zoom.
 */

export const ARCSECONDS_PER_DEGREE = 3600;

const ANGULAR_CONTROLS = new Set(["pan_absolute", "tilt_absolute"]);

export function isAngularControl(name: string): boolean {
  return ANGULAR_CONTROLS.has(name);
}

export function arcsecondsToDegrees(value: number): number {
  return value / ARCSECONDS_PER_DEGREE;
}

/** Zoom multiplier relative to the widest setting, e.g. 120 on a 100..400 range → 1.2. */
export function zoomFactor(value: number, min: number | null | undefined): number {
  const base = min !== null && min !== undefined && min > 0 ? min : 1;
  return Math.max(value, base) / base;
}

export function formatZoomFactor(factor: number): string {
  if (!Number.isFinite(factor)) {
    return "—";
  }
  return `${factor.toFixed(1)}×`;
}

/** Display text for a PTZ axis value: "+12.4°" for pan/tilt, "1.2×" for zoom, raw otherwise. */
export function ptzValueText(name: string, value: number, min: number | null | undefined): string {
  if (isAngularControl(name)) {
    return formatDegrees(arcsecondsToDegrees(value));
  }
  if (name === "zoom_absolute") {
    return formatZoomFactor(zoomFactor(value, min));
  }
  return String(value);
}

/** Scale labels for a PTZ slider: [min, middle, max] in human units. */
export function ptzScaleLabels(control: Pick<V4L2Control, "name" | "min" | "max">): [string, string, string] {
  const min = control.min ?? 0;
  const max = control.max ?? 100;
  if (isAngularControl(control.name)) {
    return [
      formatDegrees(arcsecondsToDegrees(min)),
      min < 0 && max > 0 ? "0°" : "",
      formatDegrees(arcsecondsToDegrees(max))
    ];
  }
  if (control.name === "zoom_absolute") {
    return [formatZoomFactor(zoomFactor(min, min)), "", formatZoomFactor(zoomFactor(max, min))];
  }
  return [String(min), "", String(max)];
}
