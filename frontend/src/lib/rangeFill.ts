import type { CSSProperties } from "react";

/**
 * Inline style for a styled range input: exposes how far the thumb sits along
 * the track as `--fill` so CSS can paint the filled part of the track.
 */
export function rangeFill(value: number, min: number | null | undefined, max: number | null | undefined): CSSProperties {
  return { "--fill": `${rangeFillPercent(value, min, max)}%` } as CSSProperties;
}

export function rangeFillPercent(value: number, min: number | null | undefined, max: number | null | undefined): number {
  const low = min ?? 0;
  const high = max ?? 100;
  if (!Number.isFinite(value) || !(high > low)) {
    return 0;
  }
  const ratio = (Math.min(high, Math.max(low, value)) - low) / (high - low);
  return Math.round(ratio * 1000) / 10;
}
