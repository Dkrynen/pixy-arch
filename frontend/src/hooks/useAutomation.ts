import { useCallback, useEffect, useState } from "react";

import { fetchAutomationStatus, updateAutomationSettings } from "../lib/apiClient";
import type { AutomationSettings, AutomationStatus } from "../types/api";

export type UseAutomationResult = {
  status: AutomationStatus | null;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  applySettings: (settings: AutomationSettings) => Promise<void>;
};

export function useAutomation(): UseAutomationResult {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setStatus(await fetchAutomationStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect automation");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const applySettings = useCallback(
    async (settings: AutomationSettings) => {
      setPending(true);
      setError(null);
      try {
        setStatus(await updateAutomationSettings(settings));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to apply automation settings");
      } finally {
        setPending(false);
      }
    },
    []
  );

  return { status, isLoading, pending, error, refresh, applySettings };
}
