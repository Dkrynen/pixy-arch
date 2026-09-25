import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchAudioMeter,
  fetchAudioStatus,
  restoreAudioDefaultSource,
  setAudioDefaultSource,
  setAudioMute,
  setAudioVolume,
  startAudioMeter,
  startAudioMonitor,
  stopAudioMeter,
  stopAudioMeterKeepalive,
  stopAudioMonitor
} from "../lib/apiClient";
import type { AudioStatus } from "../types/api";

const METER_POLL_MS = 400;

export type UseAudioResult = {
  status: AudioStatus | null;
  isLoading: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  // Commands resolve true on success and false on failure (reason in `error`).
  setMuted: (muted: boolean) => Promise<boolean>;
  setVolume: (volume: number) => Promise<boolean>;
  setDefaultSource: () => Promise<boolean>;
  // Optional so pre-existing UseAudioResult test doubles stay valid.
  restoreDefaultSource?: () => Promise<boolean>;
  setMonitorRunning: (running: boolean) => Promise<boolean>;
  // Optional so pre-existing UseAudioResult test doubles in other panels stay
  // valid; the hook always provides it.
  setMeterRunning?: (running: boolean) => Promise<boolean>;
};

export function useAudio(): UseAudioResult {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the user asked for the level meter. The backend stops the meter
  // after 10 s without a poll (background tabs throttle timers), so the UI's
  // intent is tracked separately from the backend's `meter_running`.
  const meterWantedRef = useRef(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setStatus(await fetchAudioStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect PIXY audio");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const meterRunning = status?.meter_running === true;

  useEffect(() => {
    if (!meterRunning) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const meter = await fetchAudioMeter();
        setStatus((current) =>
          current ? { ...current, meter_running: meter.running, level: meter.level ?? null } : current
        );
      } catch {
        // Meter polling is best-effort; the next tick retries.
      }
    }, METER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [meterRunning]);

  // Back in the foreground: if the backend idled the meter out while this tab
  // was throttled, restart it so the meter the user turned on keeps working.
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible" || !meterWantedRef.current) {
        return;
      }
      try {
        let meter = await fetchAudioMeter();
        if (!meter.running && meterWantedRef.current) {
          meter = await startAudioMeter();
        }
        setStatus((current) =>
          current ? { ...current, meter_running: meter.running, level: meter.level ?? null } : current
        );
      } catch {
        // Best-effort; the toggle still reflects the last known state.
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Closing or navigating away stops the meter instead of leaving the mic
  // being read (the backend also stops it after 10 s without a poll).
  useEffect(() => {
    if (!meterRunning) {
      return;
    }
    const handlePageHide = () => stopAudioMeterKeepalive();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [meterRunning]);

  const run = useCallback(
    async (action: () => Promise<unknown>, rollback?: () => void): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (err) {
        rollback?.();
        setError(err instanceof Error ? err.message : "Unable to run PIXY audio command");
        return false;
      } finally {
        setPending(false);
      }
    },
    []
  );

  const setMuted = useCallback(
    async (muted: boolean) => {
      const previousStatus = status;
      setStatus((current) => (current ? { ...current, muted } : current));
      return run(() => setAudioMute(muted), () => setStatus(previousStatus));
    },
    [status, run]
  );

  const setVolume = useCallback(
    async (volume: number) => {
      const previousStatus = status;
      setStatus((current) => (current ? { ...current, volume } : current));
      return run(() => setAudioVolume(volume), () => setStatus(previousStatus));
    },
    [status, run]
  );

  const setDefaultSource = useCallback(async () => {
    return run(async () => {
      await setAudioDefaultSource();
      await refresh();
    });
  }, [run, refresh]);

  const restoreDefaultSource = useCallback(async () => {
    return run(async () => {
      await restoreAudioDefaultSource();
      await refresh();
    });
  }, [run, refresh]);

  const setMonitorRunning = useCallback(
    async (running: boolean) => {
      const previousStatus = status;
      setStatus((current) => (current ? { ...current, monitor_running: running } : current));
      return run(
        async () => {
          if (running) {
            await startAudioMonitor();
          } else {
            await stopAudioMonitor();
          }
        },
        () => setStatus(previousStatus)
      );
    },
    [status, run]
  );

  const setMeterRunning = useCallback(
    async (running: boolean) => {
      const previousStatus = status;
      const previousWanted = meterWantedRef.current;
      meterWantedRef.current = running;
      setStatus((current) =>
        current ? { ...current, meter_running: running, level: running ? current.level ?? null : null } : current
      );
      return run(
        async () => {
          if (running) {
            await startAudioMeter();
          } else {
            await stopAudioMeter();
          }
        },
        () => {
          meterWantedRef.current = previousWanted;
          setStatus(previousStatus);
        }
      );
    },
    [status, run]
  );

  return {
    status,
    isLoading,
    pending,
    error,
    refresh,
    setMuted,
    setVolume,
    setDefaultSource,
    restoreDefaultSource,
    setMonitorRunning,
    setMeterRunning
  };
}
