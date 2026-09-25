import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAutomationStatus, updateAutomationSettings } from "../lib/apiClient";
import type { AutomationSettings, AutomationStatus } from "../types/api";
import { useAutomation } from "./useAutomation";

vi.mock("../lib/apiClient", () => ({
  fetchAutomationStatus: vi.fn(),
  updateAutomationSettings: vi.fn()
}));

const mockedFetchAutomationStatus = vi.mocked(fetchAutomationStatus);
const mockedUpdateAutomationSettings = vi.mocked(updateAutomationSettings);

function status(settings: Partial<AutomationSettings> = {}): AutomationStatus {
  return {
    running: true,
    camera_in_use: false,
    holders: [],
    saved_mode: null,
    last_action: null,
    mic_unmuted: false,
    settings: {
      enabled: true,
      video_device: "auto",
      on_open: "tracking",
      on_close: "privacy",
      grace_seconds: 8,
      poll_seconds: 1,
      exclude_processes: ["pipewire", "wireplumber"],
      unmute_mic: true,
      ...settings
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useAutomation", () => {
  beforeEach(() => {
    mockedFetchAutomationStatus.mockReset();
    mockedUpdateAutomationSettings.mockReset();
  });

  it("sends only the changed fields in the PATCH", async () => {
    mockedFetchAutomationStatus.mockResolvedValue(status());
    mockedUpdateAutomationSettings.mockResolvedValue(status({ on_close: "previous" }));

    const { result } = renderHook(() => useAutomation());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.applySettings({ on_close: "previous" });
    });

    expect(mockedUpdateAutomationSettings).toHaveBeenCalledWith({ on_close: "previous" });
    expect(result.current.status?.settings.on_close).toBe("previous");
  });

  it("does not let a poll that resolves after a PATCH overwrite the newer settings", async () => {
    mockedFetchAutomationStatus.mockResolvedValueOnce(status());
    const { result } = renderHook(() => useAutomation());
    await waitFor(() => expect(result.current.status?.settings.enabled).toBe(true));

    // A poll starts, then the user disables automation before it answers.
    const slowPoll = deferred<AutomationStatus>();
    mockedFetchAutomationStatus.mockReturnValueOnce(slowPoll.promise);
    mockedUpdateAutomationSettings.mockResolvedValue(status({ enabled: false }));

    let poll!: Promise<void>;
    act(() => {
      poll = result.current.refresh();
    });
    await act(async () => {
      await result.current.applySettings({ enabled: false });
    });
    expect(result.current.status?.settings.enabled).toBe(false);

    await act(async () => {
      slowPoll.resolve(status({ enabled: true }));
      await poll;
    });

    expect(result.current.status?.settings.enabled).toBe(false);
  });

  it("drops a poll that started while a PATCH was in flight", async () => {
    mockedFetchAutomationStatus.mockResolvedValueOnce(status());
    const { result } = renderHook(() => useAutomation());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    const slowPatch = deferred<AutomationStatus>();
    const slowPoll = deferred<AutomationStatus>();
    mockedUpdateAutomationSettings.mockReturnValueOnce(slowPatch.promise);
    mockedFetchAutomationStatus.mockReturnValueOnce(slowPoll.promise);

    let patch!: Promise<void>;
    let poll!: Promise<void>;
    act(() => {
      patch = result.current.applySettings({ grace_seconds: 20 });
    });
    act(() => {
      poll = result.current.refresh();
    });
    await act(async () => {
      slowPatch.resolve(status({ grace_seconds: 20 }));
      await patch;
    });
    // The poll may have been served before the write landed.
    await act(async () => {
      slowPoll.resolve(status({ grace_seconds: 8 }));
      await poll;
    });

    expect(result.current.status?.settings.grace_seconds).toBe(20);
    expect(result.current.pending).toBe(false);
  });
});
