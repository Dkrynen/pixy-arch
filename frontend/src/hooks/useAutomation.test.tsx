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

  it("merges the changed field onto the confirmed settings and sends a complete body", async () => {
    mockedFetchAutomationStatus.mockResolvedValue(status({ grace_seconds: 12 }));
    mockedUpdateAutomationSettings.mockResolvedValue(status({ grace_seconds: 12, on_close: "previous" }));

    const { result } = renderHook(() => useAutomation());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.applySettings({ on_close: "previous" });
    });

    // The backend replaces the whole model, so nothing may be left out.
    expect(mockedUpdateAutomationSettings).toHaveBeenCalledWith({ ...status({ grace_seconds: 12 }).settings, on_close: "previous" });
    expect(result.current.status?.settings.on_close).toBe("previous");
  });

  it("builds a second PATCH on top of one still in flight", async () => {
    mockedFetchAutomationStatus.mockResolvedValueOnce(status());
    const { result } = renderHook(() => useAutomation());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    const first = deferred<AutomationStatus>();
    mockedUpdateAutomationSettings.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
      status({ enabled: false, unmute_mic: false })
    );

    let firstPatch!: Promise<void>;
    act(() => {
      firstPatch = result.current.applySettings({ enabled: false });
    });
    await act(async () => {
      await result.current.applySettings({ unmute_mic: false });
    });
    await act(async () => {
      first.resolve(status({ enabled: false }));
      await firstPatch;
    });

    expect(mockedUpdateAutomationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, unmute_mic: false })
    );
    // The older response must not undo the newer one.
    expect(result.current.status?.settings.unmute_mic).toBe(false);
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

    // The next change is built on the PATCH result, not the stale poll.
    mockedUpdateAutomationSettings.mockResolvedValue(status({ enabled: false, on_close: "none" }));
    await act(async () => {
      await result.current.applySettings({ on_close: "none" });
    });
    expect(mockedUpdateAutomationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, on_close: "none" })
    );
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
