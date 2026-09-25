import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchDevices } from "../lib/apiClient";
import type { Device } from "../types/api";

export type UseDevicesResult = {
  devices: Device[];
  selectedDeviceName: string | null;
  selectedDevice: Device | null;
  isLoading: boolean;
  error: string | null;
  /** An explicit user choice: selected now and remembered across reloads. */
  setSelectedDeviceName: (deviceName: string) => void;
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
};

export const SELECTED_DEVICE_STORAGE_KEY = "pixy-arch:selected-video-device";

type RememberedDevice = { path: string; name: string };

function deviceNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function videoIndex(device: Device): number {
  const match = /video(\d+)$/.exec(device.path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** The Pixy Arch loopback sink ("Pixy Arch Virtual", legacy "PixyPilot Virtual"). */
export function isVirtualCameraDevice(device: Device): boolean {
  const haystack = `${device.name} ${device.driver ?? ""} ${device.bus_info ?? ""}`.toLowerCase();
  return haystack.includes("virtual") || haystack.includes("loopback");
}

/**
 * Picks the device to show when the user has not chosen one: the physical
 * PIXY first, then the lowest-numbered /dev/videoN that is not the virtual
 * camera, then anything at all.
 */
export function defaultCaptureDevice(devices: Device[]): Device | null {
  const sorted = [...devices].sort((left, right) => videoIndex(left) - videoIndex(right) || left.path.localeCompare(right.path));
  return (
    sorted.find((device) => /pixy/i.test(device.name) && !isVirtualCameraDevice(device)) ??
    sorted.find((device) => !isVirtualCameraDevice(device)) ??
    sorted[0] ??
    null
  );
}

function readRememberedDevice(): RememberedDevice | null {
  try {
    const raw = window.localStorage.getItem(SELECTED_DEVICE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as RememberedDevice).path === "string" &&
      typeof (parsed as RememberedDevice).name === "string"
    ) {
      return parsed as RememberedDevice;
    }
  } catch {
    // Storage blocked or corrupt: fall back to the default device.
  }
  return null;
}

function rememberDevice(device: Device): void {
  try {
    window.localStorage.setItem(
      SELECTED_DEVICE_STORAGE_KEY,
      JSON.stringify({ path: device.path, name: device.name } satisfies RememberedDevice)
    );
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
}

/**
 * Node numbers move across replugs, so a remembered choice matches on path +
 * card name first, then on card name alone.
 */
function rememberedCaptureDevice(devices: Device[]): Device | null {
  const remembered = readRememberedDevice();
  if (!remembered) {
    return null;
  }
  return (
    devices.find((device) => device.path === remembered.path && device.name === remembered.name) ??
    [...devices]
      .sort((left, right) => videoIndex(left) - videoIndex(right))
      .find((device) => device.name === remembered.name) ??
    null
  );
}

export function useDevices(): UseDevicesResult {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceName, setSelectedDeviceNameState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const devicesRef = useRef<Device[]>([]);
  devicesRef.current = devices;

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (refreshInFlight.current) {
      // Hotplug events arrive in bursts (one per udev action). Dropping a
      // refresh while one is in flight can leave the list missing the node
      // from the final event, so queue a trailing run instead.
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    if (options.showLoading !== false) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const enumeratedDevices = await fetchDevices();
      const nextDevices = enumeratedDevices.filter((device) => device.is_capture);
      setDevices(nextDevices);
      setSelectedDeviceNameState((current) => {
        if (current && nextDevices.some((device) => deviceNameFromPath(device.path) === current)) {
          return current;
        }
        const next = rememberedCaptureDevice(nextDevices) ?? defaultCaptureDevice(nextDevices);
        return next ? deviceNameFromPath(next.path) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load devices");
    } finally {
      refreshInFlight.current = false;
      setIsLoading(false);
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh({ showLoading: false });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setSelectedDeviceName = useCallback((deviceName: string) => {
    setSelectedDeviceNameState(deviceName);
    const device = devicesRef.current.find((candidate) => deviceNameFromPath(candidate.path) === deviceName);
    if (device) {
      rememberDevice(device);
    }
  }, []);

  const selectedDevice = useMemo(
    () =>
      devices.find((device) => deviceNameFromPath(device.path) === selectedDeviceName) ?? null,
    [devices, selectedDeviceName]
  );

  return {
    devices,
    selectedDeviceName,
    selectedDevice,
    isLoading,
    error,
    setSelectedDeviceName,
    refresh
  };
}
