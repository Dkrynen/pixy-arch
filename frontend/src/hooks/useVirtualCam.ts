import { useCallback, useEffect, useState } from "react";

import { fetchVirtualCamStatus, startVirtualCam, stopVirtualCam } from "../lib/apiClient";
import type { VirtualCamStartRequest, VirtualCamStatus } from "../types/api";

export type UseVirtualCamResult = {
  status: VirtualCamStatus | null;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (request: VirtualCamStartRequest) => Promise<void>;
  stop: () => Promise<void>;
};

export function useVirtualCam(): UseVirtualCamResult {
  const [status, setStatus] = useState<VirtualCamStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setStatus(await fetchVirtualCamStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect virtual camera");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = useCallback(
    async (request: VirtualCamStartRequest) => {
      setPending(true);
      setError(null);
      try {
        await startVirtualCam(request);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to start virtual camera");
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
