import { useCallback, useEffect, useRef } from "react";

import { stopPixyPtzKeepalive } from "../lib/apiClient";
import type { PtzVector } from "../types/api";

/** Re-send cadence while held; the backend stops motion after 1.5 s of silence. */
export const PTZ_VECTOR_HEARTBEAT_MS = 500;
/** Minimum spacing between drag updates; later updates coalesce into one send. */
export const PTZ_VECTOR_MIN_INTERVAL_MS = 120;
/** Backoff before each stop retry after a failed stop (3 retries). */
export const PTZ_STOP_RETRY_DELAYS_MS = [100, 250, 500];

const STOP_VECTOR: PtzVector = { x: 0, y: 0, z: 0 };

type SendVector = (vector: PtzVector) => Promise<boolean | void>;

type Options = {
  /** Called after a stop the device accepted (e.g. to refresh telemetry). */
  onStopped?: () => void;
  /** Called when a page-exit event (pagehide/hidden/blur) halted motion. */
  onHalt?: () => void;
  /** Injectable for tests; defaults to a keepalive PATCH of the zero vector. */
  sendKeepaliveStop?: () => void;
  retryDelaysMs?: number[];
};

export type PtzVectorDrive = {
  /** Start or update continuous motion; sends are serialized and coalesced. */
  move: (vector: PtzVector) => Promise<void>;
  /**
   * Stop motion. The zero vector is sent after any in-flight vector request
   * and retried on failure. Resolves true once the device accepted the stop,
   * or immediately when nothing was moving.
   */
  stop: () => Promise<boolean>;
  isMoving: () => boolean;
};

/**
 * Owns continuous PTZ vector motion: one request in flight at a time, a
 * heartbeat that keeps the backend dead-man satisfied while the pad is held,
 * and stops that can never be overtaken by an older vector request.
 */
export function usePtzVectorDrive(send: SendVector, options: Options = {}): PtzVectorDrive {
  const sendRef = useRef(send);
  sendRef.current = send;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const movingRef = useRef(false);
  // True while a stop is being sent or retried and not yet confirmed.
  const stoppingRef = useRef(false);
  // Bumped by every move/stop/halt so a superseded stop abandons its retries.
  const generationRef = useRef(0);
  const targetRef = useRef<PtzVector | null>(null);
  const pendingRef = useRef<PtzVector | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastSentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const heartbeatRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const sendSafely = useCallback(async (vector: PtzVector): Promise<boolean> => {
    try {
      return (await sendRef.current(vector)) !== false;
    } catch {
      return false;
    }
  }, []);

  const pumpRef = useRef<() => void>(() => undefined);

  const track = useCallback((request: Promise<boolean>) => {
    const settled = request.then(() => undefined);
    inFlightRef.current = settled;
    void settled.then(() => {
      if (inFlightRef.current === settled) {
        inFlightRef.current = null;
      }
      pumpRef.current();
    });
    return request;
  }, []);

  const pump = useCallback(() => {
    if (inFlightRef.current || flushTimerRef.current !== null) {
      return;
    }
    const vector = pendingRef.current;
    if (!vector || !movingRef.current) {
      pendingRef.current = null;
      return;
    }
    const wait = lastSentAtRef.current + PTZ_VECTOR_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        pumpRef.current();
      }, wait);
      return;
    }
    pendingRef.current = null;
    lastSentAtRef.current = Date.now();
    void track(sendSafely(vector));
  }, [sendSafely, track]);
  pumpRef.current = pump;

  const move = useCallback(
    (vector: PtzVector): Promise<void> => {
      generationRef.current += 1;
      movingRef.current = true;
      stoppingRef.current = false;
      targetRef.current = vector;
      pendingRef.current = vector;
      if (heartbeatRef.current === null) {
        heartbeatRef.current = window.setInterval(() => {
          // An in-flight request already refreshes the backend dead-man.
          if (!movingRef.current || !targetRef.current || inFlightRef.current || pendingRef.current) {
            return;
          }
          pendingRef.current = targetRef.current;
          pumpRef.current();
        }, PTZ_VECTOR_HEARTBEAT_MS);
      }
      pump();
      return inFlightRef.current ?? Promise.resolve();
    },
    [pump]
  );

  const stop = useCallback(async (): Promise<boolean> => {
    if (!movingRef.current) {
      return true;
    }
    movingRef.current = false;
    const generation = ++generationRef.current;
    clearTimers();
    pendingRef.current = null;
    targetRef.current = null;
    const retryDelays = optionsRef.current.retryDelaysMs ?? PTZ_STOP_RETRY_DELAYS_MS;
    stoppingRef.current = true;
    try {
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelays[attempt - 1]));
        }
        // Order the stop after any vector request still on the wire.
        while (inFlightRef.current) {
          await inFlightRef.current;
        }
        if (generationRef.current !== generation) {
          // New motion (or a page-exit halt) superseded this stop.
          return false;
        }
        if (await track(sendSafely(STOP_VECTOR))) {
          optionsRef.current.onStopped?.();
          return true;
        }
      }
      return false;
    } finally {
      if (generationRef.current === generation) {
        stoppingRef.current = false;
      }
    }
  }, [clearTimers, sendSafely, track]);

  const isMoving = useCallback(() => movingRef.current, []);

  // Leaving the page (or the window) while the pad is held must not leave
  // the gimbal running: send a keepalive stop that survives unload.
  useEffect(() => {
    const halt = () => {
      if (!movingRef.current && !stoppingRef.current) {
        return;
      }
      movingRef.current = false;
      stoppingRef.current = false;
      generationRef.current += 1;
      clearTimers();
      pendingRef.current = null;
      targetRef.current = null;
      const sendKeepaliveStop = optionsRef.current.sendKeepaliveStop ?? stopPixyPtzKeepalive;
      sendKeepaliveStop();
      const inFlight = inFlightRef.current;
      if (inFlight) {
        // A vector still on the wire could land after the stop; repeat it.
        void inFlight.then(() => {
          if (!movingRef.current) {
            sendKeepaliveStop();
          }
        });
      }
      optionsRef.current.onHalt?.();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        halt();
      }
    };
    window.addEventListener("pagehide", halt);
    window.addEventListener("blur", halt);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", halt);
      window.removeEventListener("blur", halt);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [clearTimers]);

  // Unmount (e.g. switching views mid-drag) stops through the normal path.
  useEffect(
    () => () => {
      clearTimers();
      void stop();
    },
    [clearTimers, stop]
  );

  return { move, stop, isMoving };
}
