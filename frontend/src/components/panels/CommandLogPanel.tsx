import { useMemo, useState } from "react";
import { TerminalSquare, Trash2 } from "lucide-react";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import {
  clearCommandLog,
  useCommandLogEntries,
  type CommandLogCategory,
  type CommandLogEntry
} from "../../lib/commandLog";
import "./CommandLogPanel.css";

type Props = {
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  privacySafety: UsePrivacySafetyResult;
};

const CATEGORY_LABELS: Record<CommandLogCategory, string> = {
  hid: "HID",
  v4l2: "V4L2",
  stream: "Stream",
  focus: "Focus",
  audio: "Audio",
  record: "Record",
  safety: "Safety",
  system: "System"
};

const CATEGORY_ORDER: CommandLogCategory[] = [
  "hid",
  "v4l2",
  "stream",
  "focus",
  "audio",
  "record",
  "safety",
  "system"
];

type Filter = "all" | CommandLogCategory;

export function CommandLogPanel({ controls, videoFormats, videoCapture, pixyHid, audio, privacySafety }: Props) {
  const entries = useCommandLogEntries();
  const [filter, setFilter] = useState<Filter>("all");

  const rows = [
    {
      label: "HID",
      value: pixyHid.pendingCommand ? `pending ${pixyHid.pendingCommand}` : pixyHid.lastCommand ?? "idle"
    },
    {
      label: "V4L2",
      value: controls.pendingControl ? `writing ${controls.pendingControl}` : `${controls.controls.length} controls ready`
    },
    {
      label: "Focus",
      value: pixyHid.focusMeteringPoint
        ? `${pixyHid.focusMeteringMode ?? "selected"} @ ${pixyHid.focusMeteringPoint.x},${pixyHid.focusMeteringPoint.y}`
        : pixyHid.focusMeteringMode ?? "no target"
    },
    {
      label: "Stream",
      value: videoFormats.pending
        ? "format switching"
        : videoCapture.previewEnabled
          ? videoFormats.selectedFormat?.label ?? "preview active"
          : videoFormats.selectedFormat?.label ?? "idle"
    },
    {
      label: "Record",
      value: videoCapture.status?.recording ? "recording" : "standby"
    },
    {
      label: "Audio",
      value: audio.pending ? "mute pending" : audio.status?.muted ? "mic muted" : "mic live"
    },
    {
      label: "Safety",
      value: privacyStatusText(privacySafety)
    }
  ];

  const activeCategories = useMemo(() => {
    const present = new Set(entries.map((entry) => entry.category));
    return CATEGORY_ORDER.filter((category) => present.has(category));
  }, [entries]);

  // A filter whose category has no entries (e.g. after clearing the log)
  // falls back to "all" so the feed never looks silently empty.
  const effectiveFilter: Filter =
    filter !== "all" && !activeCategories.includes(filter) ? "all" : filter;

  const filtered = useMemo(
    () =>
      effectiveFilter === "all"
        ? entries
        : entries.filter((entry) => entry.category === effectiveFilter),
    [entries, effectiveFilter]
  );

  return (
    <section className="command-log-panel">
      <div className="panel-title-row">
        <TerminalSquare size={16} />
        <h2>Command log</h2>
        <button
          className="command-log-clear icon-button ghost-button"
          onClick={() => {
            setFilter("all");
            clearCommandLog();
          }}
          title="Clear event log"
          aria-label="Clear event log"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="command-log-list">
        {rows.map((row) => (
          <div className="command-log-row" key={row.label}>
            <span>{row.label}</span>
            <code>{row.value}</code>
          </div>
        ))}
      </div>

      <div className="command-log-filters" role="group" aria-label="Filter log events">
        <button
          className={effectiveFilter === "all" ? "is-selected" : ""}
          onClick={() => setFilter("all")}
          aria-pressed={effectiveFilter === "all"}
        >
          All
          <em>{entries.length}</em>
        </button>
        {activeCategories.map((category) => (
          <button
            key={category}
            className={effectiveFilter === category ? "is-selected" : ""}
            onClick={() => setFilter(category)}
            aria-pressed={effectiveFilter === category}
          >
            {CATEGORY_LABELS[category]}
            <em>{entries.filter((entry) => entry.category === category).length}</em>
          </button>
        ))}
      </div>

      <div className="command-log-feed" role="log" aria-label="Event feed">
        {filtered.length === 0 && (
          <div className="empty-state">No events yet — device, command, and hotplug activity lands here.</div>
        )}
        {filtered.map((entry) => (
          <CommandLogRow entry={entry} key={entry.id} />
        ))}
      </div>
    </section>
  );
}

function CommandLogRow({ entry }: { entry: CommandLogEntry }) {
  return (
    <div className={`command-log-entry tone-${entry.tone}`}>
      <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
      <span className="command-log-entry-cat">{CATEGORY_LABELS[entry.category]}</span>
      <code>{entry.message}</code>
    </div>
  );
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

function privacyStatusText(privacySafety: UsePrivacySafetyResult) {
  switch (privacySafety.privacyCommandState) {
    case "sending":
      return "privacy sending";
    case "applied":
      return "privacy on, mic muted";
    case "mic-failed":
      return "privacy on, mic mute failed";
    case "failed":
      return "privacy failed";
    default:
      break;
  }
  switch (privacySafety.startupPrivacyState) {
    case "enabled":
      return "startup privacy on";
    case "disabled":
      return "startup privacy off";
    case "unknown":
      return "safety settings unavailable";
    default:
      return "loading safety";
  }
}
