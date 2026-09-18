import { useCallback, useEffect, useState } from "react";

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
  setMuted: (muted: boolean) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  setDefaultSource: () => Promise<void>;
  // Optional so pre-existing UseAudioResult test doubles stay valid.
  restoreDefaultSource?: () => Promise<void>;
  setMonitorRunning: (running: boolean) => Promise<void>;
  // Optional so pre-existing UseAudioResult test doubles in other panels stay
  // valid; the hook always provides it.
  setMeterRunning?: (running: boolean) => Promise<void>;
};

export function useAudio(): UseAudioResult {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const run = useCallback(
    async (action: () => Promise<unknown>, rollback?: () => void) => {
      setPending(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        rollback?.();
        setError(err instanceof Error ? err.message : "Unable to run PIXY audio command");
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
      await run(() => setAudioMute(muted), () => setStatus(previousStatus));
    },
    [status, run]
  );

  const setVolume = useCallback(
    async (volume: number) => {
      const previousStatus = status;
      setStatus((current) => (current ? { ...current, volume } : current));
      await run(() => setAudioVolume(volume), () => setStatus(previousStatus));
    },
    [status, run]
  );

  const setDefaultSource = useCallback(async () => {
    await run(async () => {
      await setAudioDefaultSource();
      await refresh();
    });
  }, [run, refresh]);

  const restoreDefaultSource = useCallback(async () => {
    await run(async () => {
      await restoreAudioDefaultSource();
      await refresh();
    });
  }, [run, refresh]);

  const setMonitorRunning = useCallback(
    async (running: boolean) => {
      const previousStatus = status;
      setStatus((current) => (current ? { ...current, monitor_running: running } : current));
      await run(
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
      setStatus((current) =>
        current ? { ...current, meter_running: running, level: running ? current.level ?? null : null } : current
      );
      await run(
        async () => {
          if (running) {
            await startAudioMeter();
          } else {
            await stopAudioMeter();
          }
        },
        () => setStatus(previousStatus)
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
