import { useCallback, useEffect, useState } from "react";

import type { UseAudioResult } from "./useAudio";
import type { UsePixyHidResult } from "./usePixyHid";
import { fetchSettings, updateSettings } from "../lib/apiClient";
import type { AppSettings, AppSettingsUpdate } from "../types/api";

/**
 * Startup privacy is applied by the backend when the service boots. The deck
 * only reports the setting: opening or reloading the page must never close
 * the lens or mute the mic in the middle of a call.
 */
export type StartupPrivacyState = "loading" | "enabled" | "disabled" | "unknown";

/** Outcome of the last Privacy command issued from this deck. */
export type PrivacyCommandState = "idle" | "sending" | "applied" | "mic-failed" | "failed";

export type UsePrivacySafetyResult = {
  settings: AppSettings | null;
  settingsLoaded: boolean;
  startupPrivacyEnabled: boolean;
  startupPrivacyState: StartupPrivacyState;
  privacyCommandState: PrivacyCommandState;
  settingsError: string | null;
  settingsPending: boolean;
  refreshSettings: () => Promise<void>;
  saveSettings: (update: AppSettingsUpdate) => Promise<AppSettings>;
  /** Resolves true only when the camera entered privacy and the mic muted. */
  enterPrivacy: () => Promise<boolean>;
  leavePrivacy: () => Promise<boolean>;
};

export function usePrivacySafety(
  pixyHid: UsePixyHidResult,
  audio: UseAudioResult
): UsePrivacySafetyResult {
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const [privacyCommandState, setPrivacyCommandState] = useState<PrivacyCommandState>("idle");

  const refreshSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      setSettings(await fetchSettings());
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Unable to load settings");
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      setSettingsError(null);
      try {
        const loaded = await fetchSettings();
        if (!ignore) {
          setSettings(loaded);
        }
      } catch (err) {
        if (!ignore) {
          setSettingsError(err instanceof Error ? err.message : "Unable to load settings");
        }
      } finally {
        if (!ignore) {
          setSettingsLoaded(true);
        }
      }
    }

    void loadSettings();
    return () => {
      ignore = true;
    };
  }, []);

  const saveSettings = useCallback(async (update: AppSettingsUpdate) => {
    setSettingsPending(true);
    setSettingsError(null);
    try {
      const nextSettings = await updateSettings(update);
      setSettings(nextSettings);
      return nextSettings;
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Unable to save settings");
      throw err;
    } finally {
      setSettingsPending(false);
    }
  }, []);

  const enterPrivacy = useCallback(async () => {
    setPrivacyCommandState("sending");
    // Mute even when the lens command fails: a muted mic is still safer.
    const cameraOk = (await pixyHid.setTrackingMode("privacy")) !== false;
    const micOk = (await audio.setMuted(true)) !== false;
    setPrivacyCommandState(cameraOk ? (micOk ? "applied" : "mic-failed") : "failed");
    return cameraOk && micOk;
  }, [audio.setMuted, pixyHid.setTrackingMode]);

  const leavePrivacy = useCallback(async () => {
    const ok = (await pixyHid.setTrackingMode("off")) !== false;
    if (ok) {
      setPrivacyCommandState("idle");
    }
    return ok;
  }, [pixyHid.setTrackingMode]);

  // Once the camera leaves privacy (Standard/Tracking from any control), the
  // last privacy result no longer describes the device.
  useEffect(() => {
    if (pixyHid.trackingMode === "off" || pixyHid.trackingMode === "tracking") {
      setPrivacyCommandState((current) => (current === "applied" || current === "mic-failed" ? "idle" : current));
    }
  }, [pixyHid.trackingMode]);

  const startupPrivacyEnabled = settings?.safety.start_in_privacy ?? false;
  const startupPrivacyState: StartupPrivacyState =
    settings === null ? (settingsLoaded ? "unknown" : "loading") : startupPrivacyEnabled ? "enabled" : "disabled";

  return {
    settings,
    settingsLoaded,
    startupPrivacyEnabled,
    startupPrivacyState,
    privacyCommandState,
    settingsError,
    settingsPending,
    refreshSettings,
    saveSettings,
    enterPrivacy,
    leavePrivacy
  };
}
