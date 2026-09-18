import { useCallback, useEffect, useState } from "react";

import { fetchFirmwareStatus } from "../lib/apiClient";
import type { FirmwareStatus } from "../types/api";

export type UseFirmwareResult = {
  status: FirmwareStatus | null;
  isLoading: boolean;
  checking: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  checkUpdates: () => Promise<void>;
};

export function useFirmware(): UseFirmwareResult {
  const [status, setStatus] = useState<FirmwareStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setStatus(await fetchFirmwareStatus(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to read firmware versions");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await fetchFirmwareStatus(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to check for firmware updates");
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, isLoading, checking, error, refresh, checkUpdates };
}
