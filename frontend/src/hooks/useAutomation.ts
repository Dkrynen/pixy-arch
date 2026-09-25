import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAutomationStatus, updateAutomationSettings } from "../lib/apiClient";
import type { AutomationSettings, AutomationStatus } from "../types/api";

export type { AutomationSettings, AutomationStatus };

export type UseAutomationResult = {
  status: AutomationStatus | null;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** PATCHes only the given fields; the backend merges them into its settings. */
  applySettings: (update: Partial<AutomationSettings>) => Promise<void>;
};

export function useAutomation(): UseAutomationResult {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every request takes a sequence number. A response is applied only if no
  // newer response has been applied, and polls that overlap a PATCH are
  // dropped — so a stale poll can never roll the panel back to the settings
  // the PATCH replaced.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const writesInFlightRef = useRef(0);

  const applyStatus = useCallback((seq: number, next: AutomationStatus) => {
    if (seq <= appliedSeqRef.current) {
      return false;
    }
    appliedSeqRef.current = seq;
    setStatus(next);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    // A poll that overlaps a PATCH may have been served before the write.
    const startedDuringWrite = writesInFlightRef.current > 0;
    const overlapsWrite = () => startedDuringWrite || writesInFlightRef.current > 0;
    try {
      const next = await fetchAutomationStatus();
      if (!overlapsWrite() && applyStatus(seq, next)) {
        setError(null);
      }
    } catch (err) {
      if (!overlapsWrite() && seq > appliedSeqRef.current) {
        setError(err instanceof Error ? err.message : "Unable to inspect automation");
      }
    } finally {
      setIsLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const applySettings = useCallback(
    async (update: Partial<AutomationSettings>) => {
      const seq = ++requestSeqRef.current;
      writesInFlightRef.current += 1;
      setPending(true);
      setError(null);
      try {
        applyStatus(seq, await updateAutomationSettings(update));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to apply automation settings");
      } finally {
        writesInFlightRef.current -= 1;
        setPending(writesInFlightRef.current > 0);
      }
    },
    [applyStatus]
  );

  return { status, isLoading, pending, error, refresh, applySettings };
}
