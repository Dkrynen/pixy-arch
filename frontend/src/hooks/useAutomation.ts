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
  /**
   * Changes only the given fields. The PATCH body is those fields merged onto
   * the freshest server-confirmed settings (plus any PATCH still in flight),
   * never onto a copy a slow poll may have left behind.
   */
  applySettings: (update: Partial<AutomationSettings>) => Promise<void>;
};

export function useAutomation(): UseAutomationResult {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every request takes a sequence number. A response is applied only if no
  // newer response has been applied, and polls that overlap a PATCH are
  // dropped — so a stale poll can never roll the panel (or the base of the
  // next PATCH) back to the settings a PATCH replaced.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const writesInFlightRef = useRef(0);
  const confirmedSettingsRef = useRef<AutomationSettings | null>(null);
  const inFlightUpdatesRef = useRef(new Map<number, Partial<AutomationSettings>>());

  const applyStatus = useCallback((seq: number, next: AutomationStatus) => {
    if (seq <= appliedSeqRef.current) {
      return false;
    }
    appliedSeqRef.current = seq;
    confirmedSettingsRef.current = next.settings;
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
      const confirmed = confirmedSettingsRef.current;
      if (!confirmed) {
        setError("Automation settings have not loaded yet");
        return;
      }
      const seq = ++requestSeqRef.current;
      inFlightUpdatesRef.current.set(seq, update);
      // The backend replaces the whole model, so send a complete body:
      // confirmed settings, then every in-flight change in request order.
      const body = [...inFlightUpdatesRef.current.values()].reduce<AutomationSettings>(
        (merged, change) => ({ ...merged, ...change }),
        { ...confirmed }
      );
      writesInFlightRef.current += 1;
      setPending(true);
      setError(null);
      try {
        applyStatus(seq, await updateAutomationSettings(body));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to apply automation settings");
      } finally {
        inFlightUpdatesRef.current.delete(seq);
        writesInFlightRef.current -= 1;
        setPending(writesInFlightRef.current > 0);
      }
    },
    [applyStatus]
  );

  return { status, isLoading, pending, error, refresh, applySettings };
}
