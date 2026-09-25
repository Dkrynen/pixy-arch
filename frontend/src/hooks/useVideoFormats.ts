import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchVideoFormats, setVideoFormat } from "../lib/apiClient";
import type { VideoFormatOption } from "../types/api";

export type UseVideoFormatsResult = {
  formats: VideoFormatOption[];
  selectedFormat: VideoFormatOption | null;
  selectedKey: string;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setSelectedKey: (key: string) => Promise<void>;
};

export function formatKey(
  format: Pick<VideoFormatOption, "pixel_format" | "width" | "height" | "fps" | "frame_interval_100ns">
): string {
  return `${format.pixel_format}:${format.width}:${format.height}:${format.frame_interval_100ns ?? format.fps}`;
}

export function defaultPreviewFormat(formats: VideoFormatOption[]): VideoFormatOption | null {
  const preferred = [
    { pixel_format: "MJPG", width: 3840, height: 2160, fps: 30 },
    { pixel_format: "MJPG", width: 2560, height: 1440, fps: 30 },
    { pixel_format: "MJPG", width: 1920, height: 1080, fps: 60 },
    { pixel_format: "MJPG", width: 1920, height: 1080, fps: 30 },
  ];
  for (const target of preferred) {
    const match = formats.find(
      (format) =>
        format.pixel_format === target.pixel_format &&
        format.width === target.width &&
        format.height === target.height &&
        Math.abs(format.fps - target.fps) < 0.001
    );
    if (match) {
      return match;
    }
  }
  const mjpeg = formats.filter((format) => format.pixel_format === "MJPG");
  const largest = [...(mjpeg.length > 0 ? mjpeg : formats)].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.fps - a.fps
  );
  return largest[0] ?? null;
}

export function useVideoFormats(deviceName: string | null): UseVideoFormatsResult {
  const [formats, setFormats] = useState<VideoFormatOption[]>([]);
  const [selectedKey, setSelectedKeyState] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ignore replies for a device that is no longer selected (or superseded by
  // a newer load) so a slow response for device A cannot land on device B.
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;
  const loadSeqRef = useRef(0);

  const selectedFormat = useMemo(
    () => formats.find((format) => formatKey(format) === selectedKey) ?? null,
    [formats, selectedKey]
  );

  const refresh = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!deviceName) {
      setFormats([]);
      setSelectedKeyState("");
      setIsLoading(false);
      return;
    }
    const isCurrent = () => seq === loadSeqRef.current && deviceNameRef.current === deviceName;
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await fetchVideoFormats(deviceName);
      if (!isCurrent()) {
        return;
      }
      const defaultFormat = defaultPreviewFormat(loaded);
      setFormats(loaded);
      setSelectedKeyState((current) =>
        current && loaded.some((format) => formatKey(format) === current)
          ? current
          : defaultFormat
            ? formatKey(defaultFormat)
            : ""
      );
    } catch (err) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : "Unable to load video formats");
      }
    } finally {
      if (seq === loadSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [deviceName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setSelectedKey = useCallback(
    async (key: string) => {
      if (!deviceName) {
        return;
      }
      const selected = formats.find((format) => formatKey(format) === key);
      if (!selected) {
        return;
      }
      const previousKey = selectedKey;
      setSelectedKeyState(key);
      setPending(true);
      setError(null);
      try {
        const accepted = await setVideoFormat(deviceName, selected);
        if (deviceNameRef.current !== deviceName) {
          return;
        }
        const acceptedMatch = formats.find((format) => formatsMatch(format, accepted));
        setSelectedKeyState(acceptedMatch ? formatKey(acceptedMatch) : key);
      } catch (err) {
        if (deviceNameRef.current !== deviceName) {
          return;
        }
        setSelectedKeyState(previousKey);
        setError(err instanceof Error ? err.message : "Unable to set video format");
      } finally {
        setPending(false);
      }
    },
    [deviceName, formats, selectedKey]
  );

  return {
    formats,
    selectedFormat,
    selectedKey,
    isLoading,
    pending,
    error,
    refresh,
    setSelectedKey
  };
}

function formatsMatch(left: VideoFormatOption, right: VideoFormatOption): boolean {
  if (left.pixel_format !== right.pixel_format || left.width !== right.width || left.height !== right.height) {
    return false;
  }
  if (left.frame_interval_100ns != null && right.frame_interval_100ns != null) {
    return Math.abs(left.frame_interval_100ns - right.frame_interval_100ns) <= 1;
  }
  return Math.abs(left.fps - right.fps) < 0.001;
}
