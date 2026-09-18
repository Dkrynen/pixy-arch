import { useEffect, useRef, useState } from "react";

import { appendCommandLog } from "../lib/commandLog";

export type HotplugEvent = {
  action: string;
  subsystem: string;
  device_node: string | null;
  device_type: "video" | "hid";
};

export type UseHotplugEventsResult = {
  connected: boolean;
};

type Handlers = {
  onVideo: () => void;
  onHid: () => void;
};

export function useHotplugEvents({ onVideo, onHid }: Handlers): UseHotplugEventsResult {
  const [connected, setConnected] = useState(false);
  // Handler identities change when device-keyed hooks re-create their
  // callbacks; a ref keeps one stable EventSource per mount instead of
  // reconnecting on every device switch.
  const handlersRef = useRef<Handlers>({ onVideo, onHid });
  handlersRef.current = { onVideo, onHid };

  useEffect(() => {
    // EventSource retries automatically on failure; readyState tells us whether
    // the browser is still trying (CONNECTING) or gave up (CLOSED).
    const source = new EventSource("/api/hotplug/events");

    source.addEventListener("open", () => {
      setConnected(true);
      appendCommandLog({ category: "system", message: "event link connected", tone: "ok" });
      // Re-sync on (re)connect so a missed event while the link was down
      // cannot leave the device list stale.
      handlersRef.current.onVideo();
      handlersRef.current.onHid();
    });

    source.addEventListener("hotplug", (event) => {
      const hotplugEvent = parseHotplugEvent(event);
      if (!hotplugEvent) {
        return;
      }
      appendCommandLog({
        category: "system",
        message: formatHotplugEvent(hotplugEvent),
        tone: hotplugEvent.action === "remove" ? "warn" : "info"
      });
      if (hotplugEvent.device_type === "video") {
        handlersRef.current.onVideo();
      }
      if (hotplugEvent.device_type === "hid") {
        handlersRef.current.onHid();
      }
    });

    source.addEventListener("error", () => {
      setConnected(false);
      if (source.readyState === EventSource.CLOSED) {
        appendCommandLog({ category: "system", message: "event link closed", tone: "error" });
      } else {
        appendCommandLog({ category: "system", message: "event link lost — retrying", tone: "warn" });
      }
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  return { connected };
}

function formatHotplugEvent(event: HotplugEvent): string {
  const node = event.device_node ? ` ${event.device_node}` : "";
  return `${event.subsystem} ${event.action}${node}`;
}

function parseHotplugEvent(event: Event): HotplugEvent | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(event.data) as HotplugEvent;
  } catch {
    return null;
  }
}
