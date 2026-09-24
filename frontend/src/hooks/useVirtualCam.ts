import { useCallback, useEffect, useState } from "react";

import { fetchVirtualCamStatus, startVirtualCam, stopVirtualCam } from "../lib/apiClient";
import type { VirtualCamStartRequest, VirtualCamStatus } from "../types/api";

// The backend reports more than the shared VirtualCamStatus type covers; keep
// the extra runtime fields local to the virtual-cam workstream instead of
// editing the shared api types.
export type VirtualCamRuntimeStatus = VirtualCamStatus & {
  output_width: number | null;
  output_height: number | null;
  output_pixel_format: string | null;
  fps: number | null;
  frames: number | null;
  consumers: number;
  last_error: string | null;
  mode: "off" | "standby" | "live";
  armed: boolean;
};

// VirtualCamStartRequest does not carry input_format yet; the backend accepts
// it, so extend the request locally and pass it through.
export type VirtualCamStartOptions = VirtualCamStartRequest & {
  input_format?: string;
};

export type UseVirtualCamResult = {
  status: VirtualCamRuntimeStatus | null;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (request: VirtualCamStartOptions) => Promise<void>;
  stop: () => Promise<void>;
};

const RUNNING_POLL_MS = 3000;

export function useVirtualCam(): UseVirtualCamResult {
  const [status, setStatus] = useState<VirtualCamRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = (await fetchVirtualCamStatus()) as VirtualCamRuntimeStatus;
      setStatus(next);
      // A crashed pipeline surfaces through last_error on the status, not as
      // a transport failure — do not overwrite it with a generic fetch error.
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect virtual camera");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll unconditionally: keeps consumers/format fresh while running, notices
  // a crashed ffmpeg, and — just as important — adopts pipelines started by
  // another client (or the autostart task) instead of reporting stale "off".
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const start = useCallback(
    async (request: VirtualCamStartOptions) => {
      setPending(true);
      setError(null);
      try {
        await startVirtualCam(request);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to start virtual camera";
        // The backend may still have recorded a richer last_error; pull it in
        // before setting our own error so refresh() cannot clear it.
        await refresh().catch(() => undefined);
        setError(message);
      } finally {
        setPending(false);
      }
    },
    [refresh]
  );

  const stop = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await stopVirtualCam();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to stop virtual camera");
    } finally {
      setPending(false);
    }
  }, [refresh]);

  return { status, isLoading, pending, error, refresh, start, stop };
}
